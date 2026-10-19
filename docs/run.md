# Run book — Kartenzeit (Cloudflare Workers site)

Product: a historical-map explorer (OldMapsOnline-style workflow) with an
interactive map, place search, publication-year filter, swisstopo comparison
layers, a coordinated result list, an IIIF detail view and a side-by-side
comparison list. Design reference: Canton Zürich design system (see
[design-system.md](design-system.md)), data from documented original sources (see
[data-sources.md](data-sources.md)).

## Requirements

- Node.js ≥ 20 (developed on 24) and npm
- No Cloudflare credentials are needed for local development or validation
- Chromium (optional) for `scripts/browser-smoke.mjs`

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | installs `wrangler` (the only dev dependency) |
| `npm run dev` | local Workers preview on <http://127.0.0.1:8787> (assets + `/api/*` handler) |
| `npm run build` | validation step: wrangler config, asset references, module syntax, data schema |
| `npm test` | `node --test` suites for store, records/data and the Worker |
| `npm run check` | `build` + `test` + `wrangler deploy --dry-run` |
| `npm run dry-run` | bundles the Worker and writes the deploy artefact to `dist/` without uploading |
| `npm run harvest` | re-fetches the seed data (`records.json`, `sources.json`, `overlays.json`) from e-rara/swisstopo |
| `npm run harvest:offline` | rebuilds the same files from the `.cache/fetch/` responses without network access |
| `npm run verify:endpoints` | online check of every URL the data promises (original record, library viewer, thumbnail, IIIF manifest, image service, WMTS preview). Prints a per-kind summary, writes `--json <file>`, exits 1 on any non-200. 2026-10-19: **756/756 URLs, 0 failures** on the 169-record seed at `--concurrency 2 --retries 3` (23 URLs answered a transient 5xx once and 200 on the retry; the script retries transient 429/5xx/timeouts by default, `--retries n`) |
| `node scripts/browser-smoke.mjs http://127.0.0.1:8787/ --out /tmp/shot.png` | headless Chromium walkthrough: place search, year filter, viewport filter, overlay, detail/IIIF, keyboard — reports console errors and a DOM snapshot (`--mobile` for a phone viewport) |
| `node scripts/browser-check.mjs --url http://127.0.0.1:8787 --out /tmp/shots` | assertion harness (owner: zurich-maps-3): 151 checks (measured on the integrated tree, 2026-10-19) — search + keyboard selection, time range, deep-zoom region requests, keyboard pan/Home, `?sel=` deep links, the shareable viewer region (`?vv=`: written on zoom/pan, restored by a reload, impossible values dropped, cleared by “Ganzes Blatt”/closing), multi-sheet navigation (`?sh=`) with the sheet strip (one tab stop, ←/→/Home; thumbnails are fetched as they come into view), the “Blatt” jump control of the seed’s largest work (65 sheets: options, sheet 7 really loaded and centred, 390 px, no control on a 3-sheet work), real fullscreen, the panel staying unscrolled on a phone deep link, the “other sheets of this series” list, period hand-off, collection/histogram/compare (the decade bars count the other filters but *not* the period, a real mouse drag brushes a range in one gesture with a live preview, one tap still selects a decade; both panes of records with a manifest are real IIIF viewers; `+` in one pane pulls the other to the matching region — coupled through the documented extent — the switch decouples them again, 390 px stacks the panes with the switch still reachable, and the panes' cut-outs are shareable state of their own: a zoom writes `?cvv=<record id>@x,y,w,h` for the pane that really shows that region, “Ganzes Blatt” in a pane returns both coupled panes to the whole sheet and drops the parameter, and a link that names one pane's cut-out reopens exactly that region in that pane and — coupled — the same place in the other), the point filter (keyboard `P` and skip-list chip, map click, `?at=` link, empty state, 390 px), **browser history** (the app adds no entry of its own while it starts up, “forward” restores it, “back” closes an open record and keeps the search, a map drag is not a step, one “back” undoes a whole typed search), map-only and list-only view layouts, marker pins, marker clustering, **point piles** (a cluster whose records share one *documented* point — the seed’s six Zürich Stadtpläne — opens a focusable “Karten an diesem Punkt” list instead of a zoom that provably cannot split them: labelled dialog, every record in chronological order, Enter opens that record, Escape returns focus to the pin, its own “Ansicht trotzdem vergrössern” still zooms, and at 390 px the list stays inside the map with tappable rows and no clipped text), the sticky map, the “Ausschnitte” footprint layer (chip + inline switch, shared `?ex=1` link, footprint covering the point-filter crosshair, row-hover highlight, 390 px clipping), the record search inside the place box (“Karten zum Stichwort …” applies the keyword filter, its count matches the list, an unmatched query says so; “Zuerich”, “Zürich” and “zuerich” return the same rows), “Nach oben”, 320 px list layout, map-first layout (desktop/tablet **and** the phone step: at 390×844 the map starts at 483 px so 361 px of it are visible, and at 320×640 the very-small-phone step (< 400 px) puts 133 px of map on the first screen — the stock figures move into “Über das Projekt” under 600 px, and below 400 px the hero hands the lead sentence and its two links to the map while that sentence stays complete in “Über das Projekt”; the “Schnellauswahl:” caption yields so the place chips are no longer cut in half), pin/unpin from the detail panel, the georeferenced WMTS record's own “Kartenebene” toggle (on from the panel: `ov`/`ot` set, sidebar select agrees, real overlay tiles; a second press removes it again), the **Grundkarte switch** (three documented swisstopo layers, default marked, real grey tiles after a click with the old layer's tiles gone and the view unchanged, shared `?base=luftbild` link, Enter on the focused chip, 390 px), the device-local remembered list, “Suchlink kopieren”, **a pin click bringing its own result row into view** (the row is parked out of view above the viewport first, the pin is clicked with a real mouse event, and the row must end up inside the readable band, marked, left of the detail drawer and with the sticky map still on screen; at 390 px the same click must *not* move the page at all, and both cases have to announce the row in the list's `role="status"` line as `Zeile N von M ausgewählt: <Titel>` — with the “the list is scrolled to this row” clause exactly where the page really moved), **forced colors** (`Emulation.setEmulatedMedia` with `forced-colors: active`: the selected pin, the selected row and the selected decade each keep a state that differs from the unselected one — a Highlight fill/outline or a border, not only a background colour; a brushed decade range keeps its Highlight bar and its outline while the pointer is down — the panel is closed first, because its scrim swallows real mouse events), no placeholder text (`null`/`undefined`) in the UI, CSP/console/network hygiene, WCAG 2.2 AA contrast sweep, mobile layout, and a **degraded-upstream section**: it blocks the image service, the place-search API *and* the seed file `/data/records.json` on purpose and asserts that all three fall back to plain German messages, local title suggestions, working provider links and a results area that stops claiming to load (`aria-busy`, visible loading block) — plus the loading state itself on a **throttled** connection (section 8m): `#results-loading` is visible, `#result-list` carries `aria-busy="true"`, and the “Zeitraum” chart shows its “Jahresverteilung lädt …” skeleton (only while loading — the outage path drops it) until the seed arrives. Screenshots + `report.json` in `--out`; exit code 1 on any failure |
## Cloudflare Workers deployment

The repository is a **Workers static-assets site**: `public/` is uploaded as
static assets and `src/worker/index.js` handles `/api/*` (Workers-compatible
request handler, no Node APIs, no long-running server).

Wrangler configuration ([`wrangler.jsonc`](../wrangler.jsonc)):

```jsonc
{
  "name": "zurich-maps",
  "main": "src/worker/index.js",
  "compatibility_date": "2025-08-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]   // only API calls invoke the Worker, assets are served directly
  }
}
```

Because `assets.binding` is set, the Worker can read `public/data/*.json` through
`env.ASSETS` (used by `/api/records`, `/api/layers`, `/api/sources`).

### Build settings for Cloudflare (Workers Builds → “Connect Git repository”)

| Setting | Value |
| --- | --- |
| Root directory | `/` (repository root) |
| Build command | `npm run build` (or `npm ci && npm run build`) |
| Deploy command | `npx wrangler deploy` (Workers Builds runs this from the root) |
| Node version | 20 or newer (`package.json` `engines.node`, lockfile present) |
| Bindings / secrets | none required; no environment variables or API keys |

`npm ci` uses the committed `package-lock.json`. The Worker uses no bindings
beyond `ASSETS`, so no KV/D1/R2/secret setup is needed. Cloudflare performs the
production build and deployment from `main`; this repository never deploys
itself and contains no credentials.

### Bindings

| Binding | Type | Purpose |
| --- | --- | --- |
| `ASSETS` | Static assets | serves `public/` and hands the Worker the JSON data files |

Persistent server state is not required: the data ships as versioned JSON files
(`public/data/`), so no KV namespace, D1 database or queue has to be provisioned.
If a future iteration needs write state, add a Workers binding (KV/D1) in
`wrangler.jsonc` instead of a filesystem.

### Environment variables

None. Every upstream is public and keyless. If an upstream ever needs a token,
add it as a Worker secret and document the variable name here (never the value).

## Client modules (public/app/)

Each module is optional: `main.js` imports it, calls `init(ctx)` and keeps the
returned API in `ctx.moduleApis` (used by the browser checks). A module that
throws is reported in the UI (`#app-notices`) and in
`document.documentElement.dataset.moduleErrors` instead of failing silently.

| File | Provides |
| --- | --- |
| `main.js`, `store.js`, `dom.js`, `records.js` | shell, URL-backed state + bus, DOM/format helpers, record loading/indexing/filtering |
| `map.js`, `search.js`, `results.js` | slippy map with WMTS overlays and the “Ausschnitte” footprint layer, place combobox plus “Karten zum Stichwort …” record search and the “Karten an diesem Ort” point filter, filters + result list (owner: zurich-maps-2) |
| `detail.js` | detail panel with the IIIF viewer and the original-record link (owner: zurich-maps-3) |
| `iiif.js`, `upstream.js` | pure IIIF helpers (manifest parsing, region/zoom maths, `viewToExtent`/`extentToView` for the comparison coupling) and the one JSON-from-upstream fetch ladder — same-origin `/api/fetch` first, direct call as fallback (owner: zurich-maps-3) |
| `compare.js` | comparison list: pin up to four records (`?cmp=`), open two or more side by side; a pane with a IIIF manifest hosts the real viewer (owner of the viewer: maps-3, exported from `detail.js`) and the coupling switch maps the visible region onto the other panes through each record's documented extent, records without a manifest keep the WMTS tile preview; since iteration 7-18 the cut-out of each viewer pane is shareable state of its own (`?cvv=`, written and restored through maps-3's `formatCompareViews`/`parseCompareViews`) and each pane has its own “Ganzes Blatt” (owner: zurich-maps-1). Also keeps the pinned ids in this browser (`localStorage['kartenzeit.cmp.v1']`, ids only, never sent to a server); a link that carries `?cmp=` always wins over the stored list |

URL state is documented in `store.js`: `q, from, to, p, t, c, base, vp, ex, at,
place, lat, lon, z, sel, sh, vv, view, sort, ov, ot, cmp, cvv`. `sh` is the 1-based sheet of the
open digitised work (detail.js clamps it to the real canvas count and shows the
same sheet in the IIIF viewer; a work with more than twelve sheets also gets a
“Blatt” select for the direct jump to any sheet, and the strip below the viewer
only loads the thumbnails that come into view). `vv` is the visible region of that sheet in the
IIIF viewer as `x,y,w,h` in image pixels (`''` = whole sheet): the viewer writes
it debounced while zooming/panning, “Ganzes Blatt”/closing the panel removes it,
and a shared link opens exactly that cut-out (an impossible value is ignored and
dropped). `at` is the point filter `"lat,lon"`: only records
whose documented extent covers that point remain in the list and on the map
(`coversPoint` in `records.js`; a record without a stated extent cannot match).
`cvv` carries the cut-outs of the comparison panes: one `<record id>@x,y,w,h` pair
per pane that shows a cut-out instead of the whole sheet, `;`-separated and capped
at the four panes (whole sheets stay out of the link). The pairs are keyed by
record id, not by position, because the pane order follows the record that was
clicked first. The comparison writes the value debounced while zooming/panning,
each pane's “Ganzes Blatt” clears its own pair (disabled while the pane already
shows the whole sheet), and a shared link restores every pair it names. A link
that names exactly one pane opens that cut-out in the other panes as well when
the coupling is on (the coupling works through the documented extent, so “the
same place” is coarse by nature); the panes then write the propagated cut-outs
back into the link. `ex=1` draws the documented footprints of the currently
filtered records as
outlines on the map (“Ausschnitte”; `extentRects()` in `map.js` — purely visual,
`pointer-events: none`, identical extents are one rectangle, records without an
extent are counted in the status line instead of guessed).
`base` is the chosen Grundkarte (`farbe` | `grau` | `luftbild`; absent = the
default colour Landeskarte). `map.js` resolves the key against its documented
`BASE_LAYERS` and falls back to the default for an unknown or hand-edited value,
so a shared link always opens on a real swisstopo layer — the chips under the map
(`#base-layer-switch`, one `aria-pressed` button per layer) are built from that
same list, and the map badge carries the attribution of the layer in use.


A numbered cluster zooms into its records when the pins can still be separated by
zooming. When they provably cannot — every member carries the *same* documented
anchor (the seed’s six Zürich Stadtpläne sit on 47.358330 / 8.533340), or the map
is already at zoom 18 — the click opens **“Karten an diesem Punkt”** instead: a
labelled, focusable dialog that lists every record behind the number in
chronological order (`clusterCanSplit()` and `clusterRecords()` in `map.js` are
pure and covered by `tests/map.test.mjs`). Enter on a row opens that record,
Escape hands focus back to the pin, the wheel scrolls the list instead of zooming
the map, and the dialog’s own “Ansicht trotzdem vergrössern” still zooms — no
control is left doing nothing, for mouse or keyboard.

The decade chart above the year slider (`#year-histogram`, `results.js`) is a
facet of its own: its bars count every active filter *except* the period
(`q, p, t, c, at, vp`), so a narrow range never empties the chart and a visitor
sees what widening it would bring back. Each bar is a button in a toolbar
pattern (Tab reaches the chart once, ←/→/Home/End move, Enter sets that decade);
dragging across the bars brushes a range in one gesture, previewed in
`#year-histogram-hint` and committed on release as `from`/`to` (both are history
keys, so one drag is one step to undo). `histogramBinsFor()`,
`countHistogramBins()` and `brushYears()` in `results.js` are pure and covered by
`tests/histogram.test.mjs`; the browser checks drive a real mouse drag and tap.

### Browser history (back/forward)

The store turns *deliberate* state changes into real history entries, so the
browser buttons walk the way the visitor explored instead of leaving the app:

| Behaviour | Keys |
| --- | --- |
| New history entry (`pushState`) | `q, from, to, provider, type, collection, viewport, at, place, selected` |
| Replaces the current entry (`replaceState`) | `lat, lon, zoom, sheet, vv, extents, base, view, sort, overlay, otime, cmp, cvv` — panning, dragging the year control, walking the sheets of a work, the visible viewer cut-out, the footprint layer, the chosen Grundkarte, the pinned comparison list, the comparison panes' cut-outs |

Repeated changes to the same key set inside `HISTORY_COALESCE_MS` (900 ms, both
exported from `store.js`) merge into the entry that started the gesture: a typed
search and a slider drag are one step each, not one per keystroke. The typed
query gets one more rule on top (`HISTORY_TEXT_KEYS`): as long as the new text
*continues* the text of the current entry (typing or backspacing, either
direction), the change stays in that entry no matter how long the pause was — a
visitor who stops mid-word, or a busy main thread, must not split one search
into two “back” steps (measured 2026-10-19: a 1.2 s stall did exactly that, and
the harness check “one “back” undoes a whole typed search” failed). A query
typed after the box was emptied, cleared, or rewritten from scratch is a step of
its own. Two guard
rails keep the app's own start-up work out of the history — the year range is
clamped to the data right after the records arrive, and a view may write a
clamped value back (`sheet`) — so the first “back” after landing on the site
still leaves it. `popstate` re-reads the URL and notifies the modules with the
same `(state, changedKeys)` shape an ordinary update uses, so every view follows
the buttons without extra wiring (`store.applyUrl()`; `detail.js` closes or
re-opens the panel for `selected`).

## Response headers and caching

`public/_headers` (a Cloudflare Workers static-assets feature) sets
`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
`Permissions-Policy` and a Content-Security-Policy limited to the app itself plus
the image hosts it really uses (`www.e-rara.ch`, `wmts.geo.admin.ch`,
`api3.geo.admin.ch`). Because the CSP keeps `connect-src 'self'`, every upstream
JSON/IIIF request goes through `/api/*`. Cache lifetimes: fonts immutable, app
code/styles 5 min, data 10 min. Verify locally with
`curl -sI http://127.0.0.1:8787/fonts/Inter-Regular.woff2`.

> A component that sets its own `display` on an element toggled with the
> `hidden` attribute must not hide the app: `zh-base.css` enforces
> `[hidden] { display: none !important }`. Without that rule an invisible
> full-screen overlay swallows every mouse click.

## API (Worker)

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | liveness, version, allowlisted upstreams, endpoint list |
| `GET /api/records` | the seed records (5 min cache) |
| `GET /api/layers` | swisstopo overlay descriptors used by the comparison picker |
| `GET /api/sources` | the source registry shown in the UI |
| `GET /api/search/places?q=&limit=` | swisstopo `SearchServer` proxy (`type=locations`), 5 min edge cache, query bounded to 2–120 chars, limit ≤ 20 |
| `GET /api/fetch?url=` | allowlisted pass-through (e-rara IIIF, swisstopo WMTS/capabilities) with a 1 h edge cache — a *fallback* for clients where the direct CORS call fails |

The allowlist is a literal host + path-prefix list in
[`src/worker/allowlist.js`](../src/worker/allowlist.js); unknown hosts get
`403 host_not_allowed`, so the endpoint cannot be used as an open proxy. All
upstream calls send a descriptive `User-Agent`, follow redirects, and time out
after 8 s.

## Data refresh

`scripts/fetch-records.mjs` (owner: zurich-maps-0) rebuilds
`public/data/records.json`, `public/data/sources.json` and
`public/data/overlays.json` from:

- e-rara OAI-PMH (`set=zuz`, `set=landkarten`, `set=cartesgeneve`, `oai_dc`) for
  catalogue metadata,
- e-rara DOI landing pages + IIIF Presentation 2.0 manifests for holding
  institution, shelfmark, title, imprint, rights, extent, canvas count, image
  service and the library's canonical viewer URL (`og:url` corpus),
- swisstopo WMTS capabilities (`EPSG/3857/1.0.0/WMTSCapabilities.xml`) for the
  Zeitreise, Siegfriedkarte, Dufourkarte and SWISSIMAGE Zeitreise editions and
  for the comparison layers in `overlays.json`.

Responses are cached under `.cache/fetch/` (git-ignored); `--offline` re-uses
them. At most 3 concurrent requests, a pause between calls and a descriptive
`User-Agent`. No invented metadata: fields an upstream does not state stay
`null`, publication years are kept separate from depicted-map years, and overlay
records only describe editions the WMTS service advertises and serves (empty
tiles are probed and skipped, see `records.json.skipped`). Which records were
considered and kept per OAI set, and by which rule, is written into
`records.json.selection`.

## Troubleshooting

- **Map tiles stay empty** – the browser must reach `wmts.geo.admin.ch`; the
  data and UI keep working without tiles (markers, list and detail view are
  independent).
- **No place suggestions** – the Worker proxy falls back to a local title search
  and says so in the search status line (`/api/health` shows whether the Worker
  is up).
- **IIIF preview empty** – `detail.js` retries through `/api/fetch`; if that
  fails as well the panel shows the provider link plus the thumbnail.
- **A partner library is down** (e-rara refused connections on 2026-10-19) –
  thumbnails and the IIIF viewer degrade per record to the provider link; the
  harness keeps the browser's external `net::ERR_*` lines in
  `report.upstreamConsoleErrors` instead of failing the run (decision D8 in
  `coordination/README.md`), while its hostile section still blocks the image
  host on purpose and asserts the fallback panel.
- **`wrangler dev` port in use** – `npx wrangler dev --port 8788`.
- **A control looks dead after an edit** – check the browser console for
  `[kartenzeit] module "…" not available` and the `#app-notices` banner; a
  thrown `init()` disables that module only, the rest keeps working.
- **Headers changed but the browser used a cached copy** – app code is served
  with `max-age=300`; hard-reload (or check `curl -sI`).
- **Worker start error “Incorrect type for map entry …”** – a Worker entry
  module may only export the default handler; keep helper exports in separate
  modules (e.g. `src/worker/allowlist.js`).
