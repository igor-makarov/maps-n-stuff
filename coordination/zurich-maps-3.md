# zurich-maps-3 status

Iteration 7-12 (2026-10-18, ~22:50–23:2x UTC). Member `zurich-maps-3`. Paths as
before: `public/app/detail.js`, `public/app/iiif.js`, `public/styles/detail.css`,
`tests/**`, `scripts/browser-check.mjs`.

## Landed on `main` this iteration (`9f84c4f`)

**Multi-sheet works are now first-class, and the open sheet is shareable state.**

- `store.js` (maps-1's file, additive): new `sheet` state key + short URL param
  `sh`, default 1, clamped to 1–999 in `sanitise` (the real canvas count is only
  known after the manifest loads, so detail.js clamps again and writes back).
- `detail.js`: a newly chosen work starts on sheet 1; a URL with `?sel=<id>&sh=2`
  opens sheet 2 (deep link + reload paths pass `keepSheet`). `showCanvas()` reads
  the sheet from the store, clamps it to `manifest.canvases.length` and rewrites a
  mismatch so a shared URL can never name a sheet that does not exist. Closing the
  panel resets `sh` so a closed panel leaves no stale sheet in the URL.
- **Sheet strip** under the viewer stage: one button per canvas with a real
  thumbnail (`iiif.sheetThumbUrl`: manifest `thumbnail`, else the documented
  `…/full/96,/0/default.jpg` sizeByW derivative), the sheet number, `aria-current`
  on the visible one and a click handler that switches sheets. Hidden for the
  common single-sheet case; the `‹ Blatt / Blatt n von N / Blatt ›` controls and
  Alt+←/→ keep working.
- `iiif.js`: `sheetThumbUrl()` (unit-tested: manifest thumbnail wins, service
  derivation, `null` when neither exists).
- Tests: `tests/store.test.mjs` (round-trip, default omitted, clamps 0/negative/
  9999/'quatsch'/'2.7'), `tests/iiif.test.mjs` (3 cases), `tests/site.test.mjs`
  (`#page-strip` added to the module-rendered ids).
- Harness: 4 new checks — `?sh=<last>` deep link marks the right strip button,
  one real thumbnail per sheet loads, `?sh=99` is clamped and written back,
  clicking sheet 1 switches the viewer and removes `sh` (it is the default).
- **Mobile detail order**: the workflow actions (period filter, permalink, overlay
  layer) moved from the top button stack to below the viewer; on a 390 px phone
  the IIIF stage now starts ~346 px down the panel instead of behind five stacked
  buttons. A 5th new harness check asserts the stage starts within the first
  screen and that the three primary actions stay in the top row.
- **Pin from the detail panel** (`#detail-pin`, `aria-pressed`): the open record can
  be added to the comparison list and removed again without going back to the
  sidebar — useful on mobile, where the detail panel covers the sidebar. The
  button reflects shared `?cmp=` state through a store subscription; the max-4
  rule and the list itself stay in maps-1's `compare.js`. Two more harness checks
  cover pin and unpin.

Note: an earlier session (6-11) had started the same `sheet` work but timed out
before committing it; it was redone cleanly against today's tree — nothing of it
was on `main` and nothing was lost except that draft.

## Verified

- `npm run check` ✓ — validation, **85/85** `node --test`, `wrangler deploy
  --dry-run`.
- `node scripts/browser-check.mjs --url http://127.0.0.1:8787` → **59/59** on a
  real `wrangler dev`, including the seven new checks and the existing deep-zoom,
  touch, comparison, contrast, CSP and no-console-error checks.
- Real multi-sheet fixture used: `e-rara:6485160` (2 canvases, no manifest
  thumbnails, so the derived 96 px IIIF derivatives are what the strip loads).
- Integration after maps-0's 80-record harvest (`1b8d849`, rebased): 85/85 tests
  and 56/56 harness again. That run first exposed a **harness** flake, not a
  product bug: the touch pinch waits for the *newly decoded* IIIF region, and the
  new first record's cut-out is ~24 MP, so the 10 s budget expired while the very
  next drag check succeeded with the same request. Both touch waits now use the
  same 25 s budget as the other viewer waits (`ecb1342`); re-verified 57/57 and
  then 59/59. That
  also answers maps-0's open question from iteration 7-13: the two red touch
  checks were the wait, not a pointer bug (both are green with the region request
  arriving in ~10–20 s).

## Messages

- **→ maps-1**: two additive edits in your files. `store.js` gains the documented
  `sheet` key/`sh` param (same pattern as `collection`); `README.md` and
  `docs/run.md` now list `c` and `sh` in the URL key list and the harness count is
  59. The new `#detail-pin` button writes `cmp` through `ctx.store.update`, so
  your `compare.js` subscription renders it — if you would rather own the toggle,
  export it and I will call it. Revert the wording freely.
- **→ maps-2**: results/map are untouched by this change. If you ever set
  `selected` yourself, detail.js resets `sheet` to 1 when the work changes, so no
  coordination is needed.
- **→ maps-0**: `canvasCount` is now used in the strip header path only via the
  manifest; the harvested value stays the pre-manifest fact in “Umfang”. If a
  future provider has canvases without image services, the strip falls back to
  the number button (no invented thumbnail).

## Next (my area)

- Library of Congress support in `detail.js` (`record.imageService`-only records,
  no manifest) once maps-0 harvests it: `previewSection` currently requires
  `iiifManifest`; the viewer factory already accepts a service-only canvas.
- Sheet strip polish for works with many sheets (10+): virtualise or collapse
  after the first N with a “alle Blätter” toggle.
- Real-device touch check (pinch baseline still only synthetic).

---

Iteration 4-6 (2026-10-18 21:54–23:0x UTC). Member `zurich-maps-3` — owns
`public/app/detail.js`, `public/app/iiif.js`, `public/styles/detail.css`, `tests/`,
`scripts/browser-check.mjs`. Earlier iterations of this member landed the initial
test suite, the Worker boot fix, `normaliseLon` (store) and the CDP browser
harness, but this is the first status file.

## Landed on `main` this iteration

| Commit | Content |
| --- | --- |
| `6c18514` | **Critical fix in `public/app/search.js`** (maps-2's file): see below. `scripts/browser-check.mjs` now fails when a UI module dies. |
| `a86f2f0` | IIIF deep-zoom viewer: new `public/app/iiif.js` + rewritten `detail.js` + `public/styles/detail.css`, one stylesheet link in `public/index.html`, `tests/iiif.test.mjs` (18 tests), `tests/site.test.mjs` update. |
| `aa0e446` | IIIF metadata through `/api/fetch` (CSP `connect-src 'self'`), library-viewer links for all e-rara records, harness: browser-log errors + same-origin check. |
| this commit | Citation/reuse block (IIIF full-size image, METS/OAI-PMH, DOI), `[hidden]` fix for the sheet nav, touch gestures rewritten (one pointer pans, two pinch, deltas per pointer id), in-flight image kept alive (an orphaned `Image()` could be GC'd → the zoomed picture never appeared), harness: touch pinch/drag checks. |

### 1. Place search was dead — fixed (`search.js`, maps-2 please re-verify)

`init()` called `renderQuickLinks()` **before** the `let quickLinks = null`
declaration it assigns, so the module threw
`ReferenceError: Cannot access 'quickLinks' before initialization`. `main.js`
catches module errors by design, so the console only showed a warning and the app
looked fine — while no place search, no quick picks and no `#place-status` existed
(the old harness check "no uncaught console errors" still passed). Introduced by
`344f692`. Fix: declare `quickLinks` before the first render call.

Regression guards now in `scripts/browser-check.mjs`:
`every UI module initialises` (a `[kartenzeit] module "x" not available` warning is
an error), plus checks for the quick picks and for keyboard selection of a
suggestion.

### 2. IIIF deep-zoom viewer (`detail.js`, `iiif.js`, `detail.css`)

maps-2's report was right: the preview was one fixed image in a flex row with the
caption squeezed next to it. Now:

- `iiif.js` (pure, unit-tested): Presentation 2 **and** 3 parsing, label language
  maps, image-service ids, `regionByPx`+`sizeByW` request URLs, view-box maths
  (`clampView`, `zoomView` with anchor + stage aspect, `panView`, `zoomPercent`),
  `eRaraViewerUrl`.
- `detail.js` requests exactly the visible rectangle, e.g.
  `https://www.e-rara.ch/i3f/v20/6507643/1160,2395,1487,824/725,/0/default.jpg`
  (curl 200, verified again in the browser check). Zoom via buttons, `+`/`−`,
  double-click, Ctrl/⌘ + wheel; pan by drag, pinch or arrow keys; `Home` = whole
  sheet; resolution/region read-out; page navigation only for multi-sheet records;
  fallback chain region → full sheet → thumbnail + provider link, each state named.
- Deep links (`?sel=`) now open the panel and load the manifest. Before, the panel
  was pre-rendered hidden, so a shared link showed an empty preview.
- "Zeitraum dieses Blattes filtern" pushes the sheet's publication period into the
  time filter and closes the panel.
- "Im e-rara-Viewer öffnen ↗" appears when the record has an e-rara title id.

**Verified upstream facts (curl, 2026-10-18):**

- `https://www.e-rara.ch/i3f/v20/<imageId>/info.json` → width/height of the **full**
  sheet (e.g. 3808×5613) and `supports: regionByPx, sizeByW, sizeAboveFull, cors`;
  `…/<region>/1200,/0/default.jpg` returns a 200 image, so the 1000 px `webcache`
  derivative in the manifest is *not* the resolution limit.
- e-rara's router resolves **any** corpus prefix to the holding library's corpus:
  `/zut/content/zoom/22142031` → 301 → `/zuz/…` (Zentralbibliothek) and
  `/zuz/content/zoom/6507640` → 301 → `/zut/…` (ETH-Bibliothek). That is why
  `eRaraViewerUrl` can use `zut` as an entry point when the record URL is a DOI.

## Requests / messages

- **→ maps-0**: please add an optional `viewerUrl` to harvested e-rara records
  (`curl -sIL` the DOI → the canonical `/<corpus>/content/titleinfo/<id>`, then
  swap `titleinfo` for `zoom`). `iiif.js` already prefers `record.viewerUrl` and
  falls back to the manifest title id, so this is a quality improvement, not a
  blocker. Also: `Records.json` has no `canvasCount`, so the panel cannot say how
  many sheets a digitised work has before the manifest loads.
- **→ maps-1**: `public/index.html` gained one line (the `detail.css` link) and
  `tests/site.test.mjs` gained the module-rendered viewer ids in its `dynamic`
  set. `detail.css` is deliberately a separate file so `app.css` stays yours; it
  only overrides `.app-detail`'s width at ≥ 840 px and styles the viewer.
  **Your `_headers` CSP (`connect-src 'self'`) is respected**: the detail viewer
  now fetches the IIIF manifest and `info.json` through `/api/fetch` first (the
  direct e-rara call is only a fallback for a deployment without the Worker), so
  no CSP violation is logged. The harness asserts that all fetch/XHR traffic
  stays same-origin, so please keep `connect-src 'self'`. README + docs/run.md
  got accuracy edits for the viewer and the second browser harness; revert or
  reword them if you prefer your phrasing.
- **→ maps-2**: `search.js` fix above. Your `#viewer-*`-free detail markup is
  replaced; the bus events you rely on (`record:selected`, `record:deselected`,
  `view:fit`) are unchanged, and `detail.js` now also emits `view:fit` from the
  unchanged "Auf der Karte zeigen" button.

## Verified this iteration

- `npm run check` → 70 tests, `wrangler deploy --dry-run` (28.76 KiB Worker).
- `node scripts/browser-check.mjs --url http://127.0.0.1:8787` → **34/34 checks**
  on a real `wrangler dev` server, including: deep-zoom region request (725×402 px
  decoded for a 1487×824 cut-out), arrow-key pan, `Home` reset, hidden sheet nav
  for single-sheet records, `?sel=` reopening the panel, period hand-off,
  contrast sweep (WCAG 2.2 AA), no console errors, no failed requests.
- Screenshots: `/tmp/shots-3/*.png` (this runner only; regenerate with the harness).

## Next (my area)

- A comparison view ("two sheets side by side") — the viewer factory makes this
  feasible: pick a second record, mount a second `createViewer()` instance.
- Multi-sheet records: no e-rara record in the seed has more than one canvas yet, so
  the sheet navigation is only exercised with single-sheet data (the code path is
  unit-tested through `iiif.js` fixtures in `tests/iiif.test.mjs`).
- `Input.dispatchTouchEvent` covers synthetic touch; a real device check is still
  open (in particular the pinch baseline heuristic, which needs 8 px of movement).
