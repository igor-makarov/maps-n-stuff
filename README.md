# Meridian Atlas

A global historical atlas in English, inspired by OldMapsOnline’s Maps and History views. Explore archive maps from original collections or follow changing political borders on a world timeline. The interface draws on the Canton Zürich design system’s typography, spacing, colour and controls; the name and globe mark are original to this project.

- **Maps:** a worldwide OpenStreetMap basemap, worldwide place search, publication-year and collection filters, map details with original-record links, IIIF previews, and saved comparisons.
- **Borders through time:** 54 bundled world snapshots from [André Ourednik’s Historical Basemaps](https://github.com/aourednik/historical-basemaps), with a timeline, playback, BCE/CE year entry, polygon details, cross-period polity search, and shareable map positions. Open `/?view=history`.
- **Original sources:** 221 catalogue records from e-rara partner libraries, swisstopo, and a curated international Library of Congress selection. Original titles and institution names retain their source language. Coverage varies by place and period.
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

The Worker’s internal deployment name stays `zurich-maps` to retain the existing Cloudflare site. No Cloudflare credentials belong in Shurik or this repository.

## Sources and refreshes

- `npm run harvest` refreshes e-rara and Swiss map metadata and retains the audited international selection. `npm run harvest:offline` replays cached upstream responses.
- `data/international-maps.json` records the curated Library of Congress selection and provenance. `node scripts/add-international-maps.mjs` reapplies it without a network request or duplicate records. Live image endpoints were not reachable in the development environment used for this correction; run the endpoint check from a network with access to the primary services.
- `npm run harvest:history` rebuilds the pinned historical-border bundle; `npm run harvest:history:offline` replays its cache.

See [the source registry](public/data/sources.json), [data-source documentation](docs/data-sources.md), and [rights and credits](NOTICE.md). The border data is GPL-3.0-or-later; application code is MIT.

## Shurik

The four Shurik members are **stopped** while the model quota is unavailable. Brief changes no longer resume them automatically. Their saved state and manual stop/resume workflows remain available; no automatic restart is scheduled for tomorrow. The original brief is [PROMPT.md](PROMPT.md).
