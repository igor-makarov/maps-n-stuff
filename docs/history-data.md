# Historical world boundaries — data and pipeline

The History/Borders map draws *dated territorial polygons*. This file documents the
dataset, how it is produced, what it is honest about, and how to refresh it.
Coordinated as D14 in [coordination/README.md](../coordination/README.md); the
data half is `scripts/fetch-history.mjs` + `public/data/history/`, the renderer is
`public/app/history.js` (maps-3) consuming `public/app/history-data.js` (maps-2).

## Source

| | |
| --- | --- |
| Dataset | **Historical boundaries of world countries and cultural regions** |
| Publisher | André Ourednik and contributors |
| Homepage | https://github.com/aourednik/historical-basemaps |
| Data files | `geojson/world_<year>.geojson` + the publisher's `index.json` (documented in the project README) |
| Licence | **GPL-3.0** (the upstream `LICENSE` is bundled verbatim as `public/data/history/LICENSE.txt`) |
| Revision bundled | `da7a4b735ecef70aebdc9c73e409d8a2500d50f3` (2026-09-15), recorded in `index.json → source.retrieval` |
| Retrieved | 2026-10-19 |
| Coverage bundled | **52 snapshots, 8001 BCE – 2010 CE** (every usable year the publisher's index lists) |
| Not bundled | the publisher's `world_bc123000` and `world_bc10000` snapshots (pre-Neolithic range areas, not polities) — listed under `excluded` with the reason |

The upstream project describes itself as work in progress and asks users to verify
the maps against other sources. It also warns that fixed territorial borders are a
modern concept in many regions and periods, and that areas of civilisation overlap.
`BORDERPRECISION` (1 approximate, 2 moderately precise, 3 demarcated by
international law) is carried through unchanged as the feature field `b`; the app
must show it instead of hiding the uncertainty.

GPL-3.0 obligations: the licence text, the upstream revision, the description of
our modifications and the corresponding source (the upstream repository at that
revision plus this pipeline) ship in `public/data/history/ATTRIBUTION.txt` and
`LICENSE.txt`. The derived data stays GPL-3.0.

## Pipeline

```sh
node scripts/fetch-history.mjs            # refresh from the network (cache in .cache/history/)
node scripts/fetch-history.mjs --offline  # rebuild from the cache, no network
npm run harvest:history                   # same as the first command
```

Options: `--rev <ref>` (default `master`, resolved to a commit SHA and recorded),
`--budget <KiB>` per snapshot (default 300), `--precision <degrees>` (default
`0.01`), `--out`, `--cache`.

What the pipeline does, deterministically:

1. fetch the publisher's `index.json` and every `geojson/world_*.geojson` at the
   pinned revision (sequential, descriptive User-Agent, cached);
2. split rings at the antimeridian and at polar seam edges, so a ring never sweeps
   across the map;
3. simplify each ring with Ramer–Douglas–Peucker at the **finest tolerance from a
   fixed ladder (0.05° … 0.75°) whose snapshot fits the byte budget**; the applied
   tolerance is recorded per year (`toleranceDeg`);
4. quantise coordinates to `precision` (default 0.01° ≈ 1.1 km) as signed integers;
5. drop rings that collapse below a triangle, count them (`ringsDropped`), keep
   closed rings with an explicit repeated first vertex;
6. compute each feature's label anchor as the **area centroid of its largest ring**
   (`c`) and its area (`a`), sort features by area (largest first);
7. write `index.json` (years, labels, files, feature/point counts, precision mix,
   bounding box, upstream feature counts, statistics) and one snapshot per year;
8. write `LICENSE.txt` and `ATTRIBUTION.txt`.

No border is invented, interpolated or replaced by a modern one. The source
publishes **snapshots**, and the app must name the snapshot it draws for any
requested date (see `snapshotForYear` in `public/app/history-data.js`).

## Bundled schema (frozen for the renderer)

`public/data/history/index.json`

```jsonc
{
  "source": { "title", "credit", "homepage", "datasetUrl", "licence", "licenceFile",
              "attribution", "retrieval": { "retrievedAt", "requestedRef", "upstreamCommit", "upstreamCommitDate" },
              "method", "upstreamNote" },
  "schema": { "index", "snapshot", "units", "yearNumbering" },
  "stats": { "years", "earlierYear", "latestYear", "bytes", "features", "points",
             "budgetKiB", "intervalNote" },
  "years": [ { "year": 1492,            // astronomical: 0 = 1 BCE, -500 = 501 BCE
               "label": "1492 CE",
               "file": "world_1492.json",
               "features": 1347, "points": 17410, "ringsDropped": 938,
               "unnamedFeatures": 183, "backgroundFeatures": 1, "wideEdges": 1,
               "toleranceDeg": 0.18,
               "precision": { "approximate": 1346, "moderate": 0, "demarcated": 1, "unclassified": 0 },
               "bbox": [-180, -90, 180, 83.58],
               "upstream": { "filename": "world_1492.geojson", "features": 1946, "names": 1307 } } ],
  "excluded": [ { "year": -123000, "reason": "…" } ]
}
```

`public/data/history/world_<year>.json` (`world_bc<year>.json` for BCE)

```jsonc
{ "year": 1492,
  "features": [ { "n": "Spain",          // NAME ("Unnamed" when the source has none)
                  "s": "Spain",          // SUBJECTO, omitted when equal to n
                  "p": "…",              // PARTOF, omitted when empty
                  "b": 2,                // BORDERPRECISION 1..3, omitted when unstated
                  "bg": 1,               // the source's globe-spanning unattributed-space polygon
                  "c": [lon, lat],       // anchor (area centroid), integer hundredths of a degree
                  "a": 1234,             // ring area proxy (integer units²)
                  "r": [[lon,lat,…], …]  // closed rings, integer hundredths of a degree
                } ] }
```

- Coordinates are integers in `0.01°` units, longitude first, `x = round(lon/0.01)`.
  Decode with `lon = x / 100`.
- `year < 0` is BCE (astronomical numbering; the `label` field is the human form).
- `bg: 1` marks the source's unattributed-space polygons: render them (if at all)
  as a neutral background, never as a polity, and preferably skip them.
- A handful of edges still span the antimeridian (`wideEdges`): they are the
  source's pole rings and unattributed-space rings. In Web Mercator such a chord
  lies on the map's clip line, so it is harmless when the feature is drawn as
  specified. The bundled-data test pins this exemption.

## Client semantics

`public/app/history-data.js` exports the rules the UI must follow (all covered by
`tests/history-data.test.mjs`):

- `snapshotForYear(index, year)` → nearest snapshot + `exact`, `distance`,
  `direction`, `outsideRange` and a sentence naming the snapshot that is drawn;
- `formatHistoricalYear` / `parseHistoricalYear` → asymmetric BCE/CE handling
  (astronomical year 0 = 1 BCE; `500 BCE` parses to `-500`);
- `availableRange`, `snapshotGaps` → the real range and where the series is sparse;
- `precisionSummary`, `borderPrecisionLabel`, `featureName`, `historyAttribution`,
  `loadHistoryIndex`, `loadSnapshot`, `historySnapshotUrl`.

## Verification

`npm test` includes `tests/history-data.test.mjs`: 16 tests covering the pure
semantics, the pipeline's own simplification/splitting/centroid behaviour, and the
bundled dataset (every index entry has a file that parses, stays inside plausible
coordinates, reports its bytes, and ships licence + attribution).

Measured on 2026-10-19 with this pipeline: **52 snapshots, 9.1 MiB total, 15 587
features, 789 760 points**. A refresh with a different upstream revision will change
those numbers; `index.json` records the revision and the budget that produced it.
