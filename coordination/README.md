# Swarm coordination — zurich-maps

Four members (`zurich-maps-0` … `zurich-maps-3`) build one app on `main`.
Shurik gives us no messaging channel, so **`main` is the message bus**.

## Rules of the road

1. **One file per member.** Shared protocol + decisions live here. Each member
   writes its own status file `coordination/<member>.md`. Never edit another
   member's status file; reply in your own file under `## Messages to <member>`
   and mention them in the commit message.
2. **Small, frequent, rebase-then-push.** `git fetch origin main &&
   git rebase origin/main && git push origin HEAD:main`. Non-forced pushes only.
   Never rewrite `main`, never revert a teammate's commit; if you must undo
   something, add a new commit and explain it here.
3. **File ownership beats merge luck.** Each path below has an owner. If you need
   a change in someone else's file, write it in your status file as a request and
   (if it is small and unblocking) make the change and note it — do not silently
   rewrite their module.
4. **Verify claims.** Notes here are evidence, not truth — check the code and the
   upstream sources before trusting them. Timestamps are UTC.
5. **Keep the app runnable.** `main` must always build/serve: `npx wrangler dev`
   (static assets + worker) and `npm test` (node's test runner, no deps).

## Decisions

| # | Date (UTC) | Decision |
|---|-----------|----------|
| D1 | 2026-10-18 | Hosting = Cloudflare Workers with static assets (`wrangler.jsonc`, `assets.directory`), plus a small request handler in `src/worker/index.js` limited to known upstreams. No Pages. |
| D2 | 2026-10-18 | Frontend = dependency-free ES modules in `public/`. No bundler, so four agents can edit independent files without a build race. Leaflet was vendored under `public/vendor/` at the start; the copy was removed again in D5 once `map.js` was our own implementation. |
| D3 | 2026-10-18 | Design system CSS is hand-written from the canton's published tokens (see `docs/design-system.md`); `--zh-*` custom properties. |
| D4 | 2026-10-18 | Modules integrate through `public/app/store.js` (URL-backed state) + `document` custom events; modules must be optional so a missing one degrades gracefully. |
| D5 | 2026-10-18 | The vendored Leaflet copy (192 KiB, never referenced since `map.js` became our own implementation) is **removed** by maps-1 after maps-2 rewrote the map without it; `NOTICE.md`/`README.md` no longer list it. Its licence and history stay in git. |

## Architecture contract (v1)

```
wrangler.jsonc            assets -> ./public, main -> src/worker/index.js
src/worker/index.js       request handler: static API proxy/cache for CORS-blocked upstreams
public/index.html         app shell (header/nav/main/footer)          [maps-1]
public/styles/*.css       canton design tokens + components           [maps-1]
public/app/main.js        bootstrap, wires optional modules           [maps-1]
public/app/store.js       URL state + subscriptions + bus             [maps-1]
public/app/dom.js         tiny helpers (el, fmtDate, escape)           [maps-1]
public/data/records.json  real, attributed seed records + sources      [maps-0]
public/app/records.js     loader/cache/index for records               [maps-0]
public/app/map.js         Leaflet map, markers, overlays, focus        [maps-2]
public/app/search.js      place search + filter UI                     [maps-2]
public/app/results.js     results list + collection/time filters       [maps-2]
public/app/detail.js      detail panel + IIIF preview + source link    [maps-3]
public/app/iiif.js        IIIF image/manifest helpers                  [maps-3]
tests/*.test.mjs          node --test                                   [maps-3]
docs/*.md                 sources, design system, run book              [maps-0/1/3]
```

### Record schema (`public/data/records.json`)

```jsonc
{
  "id": "e-rara:22142031",              // "<providerId>:<upstream id>", stable
  "title": "…",                          // as published upstream, verbatim
  "yearStart": 1846, "yearEnd": 1846,    // PUBLICATION date of this item
  "depictedYearStart": 1846, "depictedYearEnd": 1846, // date shown on the map (may be null)
  "creators": ["…"],                     // may be []
  "providerId": "e-rara",                // see sources.json
  "institution": "Zentralbibliothek Zürich",
  "rights": "Public Domain Mark",        // verbatim upstream rights statement
  "recordUrl": "https://…",              // the original collection record
  "thumbnail": "https://…",              // IIIF/derivative image URL
  "iiifManifest": "https://…",           // optional
  "type": "map|atlas|sheet|overlay",
  "geo": { "lat": …, "lon": … },          // optional point
  "extent": { "west": …, "east": …, "south": …, "north": … }, // optional bbox
  "overlay": { … }                       // optional georeferenced tile/WMS source
}
```

### Module contract

`public/app/main.js` imports each optional module and calls `init(ctx)` if
present, where `ctx = { store, dom, bus }`:

- `store.getState()` → `{ q, from, to, p, t, c, vp, place, lat, lon, z, sel, sh, view, sort, ov, ot, cmp }` (the full set is documented in `store.js` and `docs/run.md`)
- `store.update(patch)` → merge, sync URL (`replaceState`), notify subscribers
- `store.subscribe(fn)` → `fn(state, changedKeys)`, returns unsubscribe
- `bus.emit(name, detail)` / `bus.on(name, fn)` for `records:loaded`,
  `records:filtered`, `place:selected`, `record:selected`, `map:moved`.

Anything outside this contract is free. Missing modules must not break the shell.

## Status board

| Member | Owns | Status (integrated tree, iteration 7-15) |
|--------|------|-------------------------|
| zurich-maps-0 | worker proxy, records seed + source registry | ✅ **109 records**: e-rara OAI-PMH/IIIF (26 ZB Wildkarte sheets, 26 ETH `landkarten`, 18 Zürich plans + 11 Zürich-region maps via SRU 1.2, 1 Genf) + 27 swisstopo overlay editions; canton-window and per-decade selection rules, holding library never defaulted, `docs/data-sources.md` + `sources.json` registry |
| zurich-maps-1 | shell, design system, store, wrangler, docs, compare | ✅ map-first compact shell, canton design tokens/components (48 px controls), URL-backed store, comparison view + device-local Merkliste, cantonal “Nach oben”, Workers config + run book, unused vendor payload removed |
| zurich-maps-2 | map, search, results/filters | ✅ own slippy map (no library) with clustering + WMTS overlays, swisstopo place search, time/collection/provider/viewport facets, decade histogram, point filter (`at=`) |
| zurich-maps-3 | detail view, IIIF, tests, harness | ✅ IIIF deep-zoom viewer + keyboard sheet strip + fullscreen, honest degraded-upstream states, series navigation; 101 unit tests and the 90-check CDP harness |

Integration gate as of iteration 7-15 (verified on this runner, 109-record seed):
`npm run check` (validation + **101** unit tests + `wrangler deploy --dry-run`) and
`node scripts/browser-check.mjs` **90/90** against `npx wrangler dev`.
