# zurich-maps-0 status

Iteration 1-1 (2026-10-18, UTC). Member `zurich-maps-0`.

## Reaction to the maps-1 contract (accepted)

I arrived with a Vite+TypeScript+Leaflet scaffold plan. `zurich-maps-1` landed the
no-bundler ESM contract on `main` first (D1–D4) and it is a good fit for four
parallel agents: no build race, static assets + worker on Workers, `npx wrangler dev`
preview, `node --test`. **I dropped my scaffold and adopted the maps-1 contract
unchanged** — no competing shell, no bundler. My earlier protocol draft was
withdrawn; `coordination/README.md` stays exactly as maps-1 wrote it.

## Claimed (per the maps-1 status board, plus what I actually took)

- `public/data/sources.json` — provider/source registry (primary record URL,
  identifiers, rights, attribution, retrieval date, endpoints actually used).
- `public/data/records.json` — real, attributed seed records.
- `public/app/records.js` — loader/index/filter/search over records (D4 schema).
- `src/worker/index.js` **handler body** — allowlisted upstream proxy + edge cache
  (maps-1 owns the scaffolding/config; I filled in the body as invited).
- `scripts/**` — reproducible refresh/validation scripts (Node, no deps).
- `docs/SOURCES.md`, `docs/PROGRESS.md`.
- `tests/records.test.mjs` — my data-layer tests only (maps-3 owns the rest of `tests/`).

## Answered messages

- **→ maps-1:** D1–D4 accepted, schema kept exactly. `records.json` validates in
  `node --test`. I do not touch `public/index.html`, `public/styles/**`,
  `public/app/main.js`, `store.js`, `dom.js`, `wrangler.jsonc`.
- **→ maps-2:** records carry `geo` (point) and `extent` (bbox) where the upstream
  publishes them; `records.js` exposes `filterRecords(state, records)` and
  `recordsInBounds(records, bounds)` so the map can synchronise with the result
  list without re-implementing time/provider filtering.
- **→ maps-3:** every record has `recordUrl`, `rights`, `institution`,
  `thumbnail` and (where upstream offers it) `iiifManifest`; thumbnails are
  direct IIIF image URLs so `detail.js` can also build a deeper zoom URL from
  `iiifManifest`.

## Verified upstream facts (checked 2026-10-18; evidence, please re-verify before trusting)

- swisstopo WMTS capabilities `https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml`
  (688 layers, CORS `*`):
  - `ch.swisstopo.zeitreihen` "Zeitreise – Kartenwerke", 178 `Time` values
    `YYYYMMDD` 18441231…20211231, matrix set `3857_18`,
    bbox `5.140242 45.398181 / 11.47757 48.230651`,
    template `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/{Time}/3857/{TileMatrix}/{TileCol}/{TileRow}.png`
  - `ch.swisstopo.hiks-siegfried` "Siegfriedkarte", 80 `Time` values 1870…1949.
  - `ch.swisstopo.hiks-dufour` "Dufourkarte Erstausgabe", single value `current`.
  - These are **georeferenced overlays** (real imagery, no coordinates invented).
- `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=…&type=locations&sr=4326&limit=n`
  → `results[].attrs.{label,lat,lon,geom_st_box2d,origin,rank}`, CORS `*`.
- e-rara IIIF Presentation 2.0 at `https://www.e-rara.ch/i3f/v20/<titleId>/manifest`;
  Image API 2 level2 `…/i3f/v20/<imageId>/info.json` (`supports: cors, regionByPx,
  sizeByW, …`); thumbnails `…/i3f/v21/<imageId>/full/304/0/default.jpg`; manifest
  `metadata` carries title/imprint/holding institution/online-since verbatim.
- e-rara OAI-PMH `https://www.e-rara.ch/oai?verb=Identify` → "Visual Library Server",
  granularity `YYYY-MM-DDThh:mm:ssZ`.
- Canton Zürich tokens (Apache-2.0 repo `Kanton-Zurich/frontend-designsystem@master`,
  `src/assets/css/globals/_variables.scss`): blue `#0070b4`, darkblue `#00407c`,
  cyan `#009ee0`, bordeaux `#b01657`, violet `#7f3da7`, green `#1a7f1f`,
  black scale `#000/#333/#666/#949494/#ccc/#d9d9d9/#f0f0f0/#f7f7f7`, Inter 400/900
  + Helvetica fallback, sizes 4/8/12/16/20/24/28/32/40/48/56/80, breakpoints
  0/320/400/600/840/1024/1280, content width 1168 / text 768 / max 1440, button
  `border-radius: 1px` black-filled with Inter Black, spinner `#009ee0`.
  Accessibility: WCAG 2.2 AA + eCH-0059 (zh.ch "Vorgaben zur Barrierefreiheit").

## Blockers

- No Cloudflare credentials in this runner → deployment stays documented
  (`wrangler deploy --dry-run` verification only).
- Playwright is not installed; `chromium`/`google-chrome` binaries exist, so
  headless screenshots are possible.
