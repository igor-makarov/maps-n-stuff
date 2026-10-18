# Data contract — records, sources, worker proxy (owner: `zurich-maps-0`)

Additive to `coordination/README.md`. Changes here are announced in
`coordination/zurich-maps-0.md`; the record schema itself is fixed by D4 and is
**not** changed unilaterally.

## Files

| File | Purpose |
| --- | --- |
| `public/data/records.json` | seed records, generated/extended by `scripts/`, consumed by `public/app/records.js` |
| `public/data/sources.json` | source registry: provider metadata, endpoints actually used, rights, retrieval date |
| `scripts/fetch-*.mjs` | reproducible refresh scripts (Node 20+, no dependencies) |
| `public/app/records.js` | load/validate/index/filter/search — the only place that knows record internals |
| `src/worker/index.js` | `/api/*` proxy, allowlist, edge cache, upstream User-Agent |

## Record schema (D4, with the fields `records.js` guarantees)

```jsonc
{
  "id": "e-rara:22142031",
  "title": "Switzerland",                        // verbatim upstream
  "yearStart": 1883, "yearEnd": 1883,            // PUBLICATION date (from upstream imprint)
  "depictedYearStart": null, "depictedYearEnd": null, // date shown on the map, only if upstream states it
  "creators": ["Blackie & Son"],
  "providerId": "e-rara",
  "institution": "Zentralbibliothek Zürich",
  "rights": "Public Domain Mark",                // verbatim upstream rights statement
  "recordUrl": "https://www.e-rara.ch/zuz/content/titleinfo/22142031",
  "thumbnail": "https://www.e-rara.ch/i3f/v21/22142032/full/304/0/default.jpg",
  "iiifManifest": "https://www.e-rara.ch/i3f/v20/22142031/manifest",
  "type": "map",
  "geo": { "lat": 47.37, "lon": 8.54 },           // only with a stated upstream place/bbox
  "extent": { "west": 5.83, "east": 10.5, "south": 45.66, "north": 47.83 },
  "overlay": {                                    // georeferenced raster source
    "kind": "wmts",
    "urlTemplate": "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/18831231/3857/{TileMatrix}/{TileCol}/{TileRow}.png",
    "layerId": "ch.swisstopo.zeitreihen",
    "timeValue": "18831231",
    "maxZoom": 18,
    "attribution": "© swisstopo – Zeitreise (Kartenwerke)"
  }
}
```

Rules enforced by `tests/records.test.mjs`:

1. `id` unique and `providerId:id`-shaped; `providerId` exists in `sources.json`.
2. `recordUrl` is `https://` and points at the holding institution/aggregator record.
3. `yearStart`/`yearEnd` present and plausible (1400 ≤ y ≤ 2100, start ≤ end).
4. `rights`, `institution`, `thumbnail` non-empty; `thumbnail` is `https://`.
5. `depicted*` only when the upstream actually documents it; never inferred from
   the publication date.
6. `extent` (if present) is a valid bbox: west < east, south < north, WGS84.
7. `overlay.urlTemplate` host is in the registry allowlist of `sources.json`.

## Worker proxy (`src/worker/index.js`)

Only for upstreams that lack CORS or need caching; the browser talks to
`wmts.geo.admin.ch`, `www.e-rara.ch` and `api3.geo.admin.ch` directly where CORS
allows it (all three send `access-control-allow-origin: *`).

- `GET /api/health` → `{ ok, version, upstreams }`
- `GET /api/search/places?q=&limit=` → proxied swisstopo `SearchServer`
  (`type=locations`), 5-minute edge cache, strict `q` length/limit bounds.
- `GET /api/layers` → curated historical-overlay descriptors derived from
  `public/data/sources.json` (time values, template, attribution).
- `GET /api/records` → the seed records with `Cache-Control: public, max-age=300`.
- Allowlist is a literal host list; unknown paths return 404 JSON; upstreams get a
  descriptive `User-Agent` and a 8 s timeout.
