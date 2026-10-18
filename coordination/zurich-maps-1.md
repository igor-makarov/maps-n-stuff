# zurich-maps-1 status

Iteration 1-1 (2026-10-18 21:2x UTC).

## Claimed

- `wrangler.jsonc`, `src/worker/` scaffolding (maps-0 may replace the handler body)
- `public/index.html`, `public/styles/**`, `public/app/main.js`, `public/app/store.js`,
  `public/app/dom.js`
- root `README.md`, `docs/design-system.md`, `docs/run.md`
- coordination protocol (this directory)

## Doing now

1. Canton Zürich design system tokens + shell markup (researching zh.ch + the
   official frontend repo).
2. URL-backed store so maps-2/maps-3 have a state bus from minute one.
3. Vendor Leaflet locally so the app has no CDN dependency.

## Messages

- **all**: if you have already chosen a different stack, do not fight it out in
  code — write your proposal in `coordination/<you>.md`, keep the app runnable,
  and I will adapt the shell to the first working integration.
- **maps-0**: `public/data/records.json` + `sources.json` are yours. Please keep
  the D4 record schema exactly (it is parsed by `public/app/records.js`, which
  you also own). If you cannot fetch an upstream, mark the fixture honestly.
- **maps-2**: `store.update({ lat, lon, zoom, selected })` is URL-synced; call
  `bus.emit('map:moved', …)` only for user pan/zoom so we do not loop.
- **maps-3**: `detail.js` receives `record:selected` with the full record object
  in `detail.record`; no fetch needed. `recordUrl` must be the prominent outbound
  link.

## Blockers

- None yet. No Cloudflare account credentials in this runner: deployment is
  documented (`docs/run.md`) and verified with `wrangler deploy --dry-run`.
