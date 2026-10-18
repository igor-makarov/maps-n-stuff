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
| `node scripts/browser-smoke.mjs http://127.0.0.1:8787/ --out /tmp/shot.png` | headless Chromium walkthrough: place search, year filter, viewport filter, overlay, detail/IIIF, keyboard — reports console errors and a DOM snapshot (`--mobile` for a phone viewport) |
| `node scripts/browser-check.mjs --url http://127.0.0.1:8787 --out /tmp/shots` | assertion harness (owner: zurich-maps-3): 80 checks — search + keyboard selection, time range, deep-zoom region requests, keyboard pan/Home, `?sel=` deep links, multi-sheet navigation (`?sh=`) with the sheet strip (one tab stop, ←/→/Home), real fullscreen, the panel staying unscrolled on a phone deep link, period hand-off, collection/histogram/compare, map-only and list-only view layouts, marker pins, marker clustering, the sticky map, 320 px list layout, map-first layout, pin/unpin from the detail panel, the device-local remembered list, “Suchlink kopieren”, no placeholder text (`null`/`undefined`) in the UI, CSP/console/network hygiene, WCAG 2.2 AA contrast sweep, mobile layout, and a **degraded-upstream section**: it blocks the image service and the place-search API on purpose and asserts that both fall back to plain German messages, local title suggestions and working provider links. Screenshots + `report.json` in `--out`; exit code 1 on any failure |

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
| `map.js`, `search.js`, `results.js` | slippy map with WMTS overlays, place combobox, filters + result list (owner: zurich-maps-2) |
| `detail.js` | detail panel with the IIIF viewer and the original-record link (owner: zurich-maps-3) |
| `compare.js` | comparison list: pin up to four records (`?cmp=`), open two or more side by side with their IIIF/WMTS previews (owner: zurich-maps-1). Also keeps the pinned ids in this browser (`localStorage['kartenzeit.cmp.v1']`, ids only, never sent to a server); a link that carries `?cmp=` always wins over the stored list |

URL state is documented in `store.js`: `q, from, to, p, t, c, vp, place, lat, lon,
z, sel, sh, view, sort, ov, ot, cmp`. `sh` is the 1-based sheet of the open
digitised work (detail.js clamps it to the real canvas count and shows the same
sheet in the IIIF viewer).

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
- **`wrangler dev` port in use** – `npx wrangler dev --port 8788`.
- **A control looks dead after an edit** – check the browser console for
  `[kartenzeit] module "…" not available` and the `#app-notices` banner; a
  thrown `init()` disables that module only, the rest keeps working.
- **Headers changed but the browser used a cached copy** – app code is served
  with `max-age=300`; hard-reload (or check `curl -sI`).
- **Worker start error “Incorrect type for map entry …”** – a Worker entry
  module may only export the default handler; keep helper exports in separate
  modules (e.g. `src/worker/allowlist.js`).
