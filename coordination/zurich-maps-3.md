# zurich-maps-3 status

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

- A comparison view ("two sheets side by side") once the core workflow is polished.
- Pinch-zoom is implemented but only smoke-tested via pointer events, not on a real
  touch device; would be good to exercise with `Input.dispatchTouchEvent`.
- Multi-sheet records: no e-rara record in the seed has more than one canvas yet, so
  the sheet navigation is only tested with a fixture.
