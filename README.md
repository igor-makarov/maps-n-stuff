# Meridian Atlas

A global historical atlas in English, inspired by OldMapsOnline’s Maps and History views. Explore archive maps from original collections or follow changing political borders on a world timeline. The interface draws on the Canton Zürich design system’s typography, spacing, colour and controls; the name and globe mark are original to this project.

- **Maps:** worldwide OpenStreetMap and NASA satellite reference layers, global place search, date and collection filters, original-record links, IIIF previews, and saved comparisons. NASA Blue Marble is a 500 m overview; zooming closer enlarges the imagery.
- **Borders through time:** 54 bundled world snapshots from [André Ourednik’s Historical Basemaps](https://github.com/aourednik/historical-basemaps), with a timeline, playback, BCE/CE year entry, polygon details, cross-period polity search, and shareable map positions. Open `/?view=history`.
- **Original sources:** 31,692 bundled catalogue records: 24,000 USGS Historical Topographic Map Collection sheets, 4,464 explicitly public-domain Stanford maps, 3,045 e-rara maps, 105 SLUB Dresden maps, 51 Library of Congress Geography and Map Division records and 27 swisstopo entries, all with per-item rights evidence. Search additional original LoC and USGS collections on demand. Live adapters require network access to those institutions and admit only compatible rights statements; they are not a claim to have imported every holding. Doria/National Library of Finland, Leventhal/Boston Public Library and the Digital Commonwealth partner scope were harvested with per-item image rights but are withheld from the shipped catalogue because a primary metadata-reuse licence was not established; their records and evidence remain in `research/withheld/`.
- **Georeferencing:** 117 provider-supplied Stanford GeoTIFF overlays plus 23,945 USGS GeoTIFF records read their own CRS and pixel transform (55 further USGS GeoPDF-only products keep their original PDF and make no COG claim); the USGS raster links are provider-supplied and sampled rather than each individually decoded. Other IIIF scans can look up reusable Allmaps alignments or open in its georeferencing editor. A missing alignment, date, extent or thumbnail does not exclude an otherwise eligible scan. Source titles and institution names retain their original language.
- **Honest geography:** publication dates and depicted periods are separate. Border gaps use an explicitly named nearest snapshot. Approximate place anchors for international archive records are labelled; they never become fabricated map extents. Optional Swiss overlays cover Switzerland.

## Run and check

```sh
npm ci
npm run dev
```

`npm run check` validates the assets and data, runs the unit suite, and packages the Worker with `wrangler deploy --dry-run`. With the local preview running, `node scripts/browser-global-check.mjs` checks the English UI, global navigation, source links, historical polygons, timeline races, shared map positions, keyboard controls and mobile layouts at 390 and 320 pixels. External services are deliberately blocked in that browser check; it does not verify live archive image or geocoder availability. `npm run verify:endpoints` performs the separate live endpoint check.

## Cloudflare Workers

Cloudflare’s connected repository integration handles build and deployment from `main`:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: repository root

The package, Wrangler Worker and new Shurik member names are `maps-n-stuff`, matching the repository. The Cloudflare connected Worker must also be named `maps-n-stuff`; an existing `zurich-maps` project needs that dashboard migration and any custom-domain reassignment. Changing this repository does not rename an account-side Worker. No Cloudflare credentials belong in Shurik or this repository.

## Sources and refreshes

- `npm run harvest` imports the complete eligible map subset of Stanford’s pinned CC0 institutional metadata repository. The image-rights gate is separate: each admitted item must explicitly carry PDM/CC0 and no conflicting restrictions. The importer has no geography, decade or count quota. `npm run harvest:offline` reuses its checkout; `node scripts/harvest-global.mjs --input /path/to/checkout --offline` uses an existing checkout at the pinned revision.
- `npm run harvest:regional` refreshes the legacy e-rara/Swiss holdings while preserving the global collections. Their historic sampling limits remain documented; the Stanford import has no such limit.
- `data/international-maps.json` records the curated Library of Congress selection and provenance. `node scripts/add-international-maps.mjs` reapplies it without a network request or duplicate records. Live image endpoints were not reachable in the development environment used for this correction; run the endpoint check from a network with access to the primary services.
- `npm run harvest:history` rebuilds the pinned historical-border bundle; `npm run harvest:history:offline` replays its cache.

See [the source registry](public/data/sources.json), [data-source documentation](docs/data-sources.md), and [rights and credits](NOTICE.md). The border data is GPL-3.0-or-later; application code is MIT.

The [global catalogue audit](docs/global-catalogue-audit.md) records integration routes, rights restrictions and real georeferencing requirements for all 50 entries in OldMapsOnline's public partner directory. Its [research registry](data/catalogue-source-audit.json) is separate from the deployed source list; prospective providers have not been imported or cleared wholesale.

## Shurik

The authorized 20 October sourcing run uses **three** DeepSeek v4.1 Flash agents
with max reasoning, 30-minute iteration budgets, zero waiting and automatic task
checkpoints disabled. Its hard deadline is **16:00 Asia/Jerusalem (13:00 UTC)**.
The agents coordinate themselves and commit validated source integrations to `main`.
Read [the sourcing brief](SOURCING_PROMPT.md) and [current steering](SOURCING_STEERING.md).

The model workflow remains manual-only. The separate sourcing launcher accepts
only the exact reviewed request in `.github/shurik/sourcing-run.json`, once, before
its deadline; it refuses changed requests, existing member controls and active
retired loops. Routine source/configuration edits cannot restart a paused swarm.
All eight retired agents remain stopped. Hard OpenCode usage-cap errors stop a
member durably rather than creating an endless zero-wait retry loop. Manual brief
updates preserve the saved hard deadline. Cloudflare still handles deployment.
