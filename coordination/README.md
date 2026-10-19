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
| D6 | 2026-10-18 | **Browser history is part of the URL contract** (`store.js`, maps-1): changing `q, from, to, provider, type, collection, viewport, at, place, selected` opens a history entry (`pushState`); everything else (`lat, lon, zoom, sheet, view, sort, overlay, otime, cmp`) replaces the current one. Changes to the same key set within `HISTORY_COALESCE_MS` (900 ms) merge, so a typed search or a slider drag is one step. `popstate` re-reads the URL and notifies subscribers like `update()` does — modules need no extra wiring, but a module that *clears* a selection must expect `detail.js` to close its panel, and no module may write state during start-up in a way that consumes the visitor's first “back”. |
| D7 | 2026-10-19 | **The comparison panes' cut-outs are their own URL key** (`cvv`, maps-3 in maps-1's `store.js`/`compare.js`): one `id@x,y,w,h` pair per pane that shows a cut-out instead of the whole sheet, `;`-separated, capped at the four panes and keyed by **record id** (the pane order follows the clicked record, so position would break a link). Like `vv`, the whole sheet is the default and stays out of the link, the region is the same `x,y,w,h` token, and the pane that restores it validates it against its real sheet. `cvv` is *not* a history key: a zoom/drag replaces the current entry, so the back button still walks the exploration (D6). A link naming one pane's cut-out is opened in the other panes too when the coupling is on — that is what “gekoppelt” promises — and the propagated cut-outs are written back. |
| D8 | 2026-10-19 | **An upstream outage is evidence, not a product failure** (`scripts/browser-check.mjs`, maps-1, small repair to maps-3's file): the console-hygiene check now filters browser-level `Failed to load resource: net::ERR_*` for **external** hosts into `report.upstreamConsoleErrors` instead of failing the run. Our own origin, our own exceptions and the deliberate `ERR_BLOCKED_BY_CLIENT` assertions still fail. Reason: e-rara refused connections during iteration 7-18 (42 browser errors, 0 app errors) and the run reported 138/139 although the app had degraded exactly as designed; the fallback itself stays asserted in the hostile section. |
| D9 | 2026-10-19 | **Below 400 px the first screen belongs to the map, not to the hero** (maps-1, `public/styles/app.css` only): at ≤ 399 px the black bar's design note, the hero lead + its two links and the “Schnellauswahl:” caption are hidden, because each of them stands again on the page (`Über das Projekt`, `#sources`, the header nav, the group's `aria-label`) and they cost 150 px above the map. Measured 320×640: map top 658 → 507 px (0 → 133 px of map); 390×844: 609 → 483 px (235 → 361 px). ≥ 400 px unchanged. The harness asserts the 320 px map and the relocated sentence. If a module ever *depends* on one of those nodes at ≤ 399 px, say so in your status file before adding it back. |
| D10 | 2026-10-19 | **The loading skeleton is driven by the shell's own loading state** (maps-1, `app.css`; maps-2's `#result-list` is the signal): `#year-histogram:empty` shows “Jahresverteilung lädt …” exactly while `.app-side:has(#result-list[aria-busy='true'])` holds, i.e. until `finishLoading()` in `main.js` clears it — and therefore also in the seed-outage case, where results.js never runs. Keep the `aria-busy` flag and `#results-loading` in sync as documented in `docs/run.md`; the harness (8m) throttles the connection and asserts both plus the skeleton. |
| D6a | 2026-10-19 | **A still-edited query stays in its entry** (`store.js`, maps-1; extends D6): while a `q` change continues the text of the current entry (typing *or* backspacing, either direction — `HISTORY_TEXT_KEYS`), it replaces instead of pushing even after a pause longer than `HISTORY_COALESCE_MS`. Measured before the change: a 1.2 s stall in the middle of “Zürich” pushed a second entry, so one “back” left `?q=Zür` behind instead of the unfiltered list. A cleared box or a query rewritten from scratch is still its own step. The harness check now types with a deliberate 1.2 s stall. |

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
public/app/map.js         own slippy map, markers, WMTS overlays       [maps-2]
public/app/search.js      place search + filter UI                     [maps-2]
public/app/results.js     results list + collection/time filters       [maps-2]
public/app/detail.js      detail panel + IIIF preview + source link    [maps-3]
public/app/iiif.js        IIIF image/manifest helpers                  [maps-3]
public/app/upstream.js    the one JSON-from-upstream fetch ladder      [maps-3]
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

- `store.getState()` → `{ q, from, to, provider, type, collection, base, viewport, extents, at, place, lat, lon, zoom, selected, sheet, vv, view, sort, overlay, otime, cmp }` (the full set is documented in `store.js` and `docs/run.md`)
- `store.update(patch)` → merge, sync URL (`replaceState`), notify subscribers
- `store.subscribe(fn)` → `fn(state, changedKeys)`, returns unsubscribe
- `bus.emit(name, detail)` / `bus.on(name, fn)` for `records:loaded`,
  `records:filtered`, `place:selected`, `record:selected`, `map:moved`.

Anything outside this contract is free. Missing modules must not break the shell.

## Status board

| Member | Owns | Status (integrated tree, 2026-10-19) |
|--------|------|-------------------------|
| zurich-maps-0 | worker proxy, records seed + source registry | ✅ **199 records**: e-rara OAI-PMH/IIIF (26 ZB Wildkarte sheets, **56** ETH `landkarten` sheets — the 7-19 widening reads 30 of the set's 2335 records, pools 125 candidates and keeps the union of the oldest 26 and a per-decade spread, so the set now spans **1547–1900** —, **47** Zürich plans + 11 Zürich-region + 10 city ground/site plans + 21 Europe/world/country overview maps via SRU 1.2 (twelve questions since 7-20: continent keywords plus Deutschland/Italien/Frankreich/… , pooled in rounds with a 7-per-keyword quota), 1 Genf) + 27 swisstopo overlay editions; seed spans **1547–2021**; canton-window (mirrored for the world set), per-decade and `zuz`-first selection rules, holding library never defaulted, keyword search covers collection/imprint, `npm run verify:endpoints` (maps-0's line states the last measured count; the script retries transient 429/5xx because e-rara's DOI pages throttle), `docs/data-sources.md` + `sources.json` registry |
| zurich-maps-1 | shell, design system, store, wrangler, docs, compare | ✅ map-first compact shell incl. the **phone step** and honest **loading/seed-outage states**: hero figures move to “Über das Projekt” below 600 px, and since 7-19 the **very-small-phone step (D9, ≤ 399 px)** spends the first screen on the map — 320×640 658 → 507 px (0 → 133 px visible), 390×844 609 → 483 px (361 px visible) — while the design note/lead leave copies in “Über das Projekt”/the footer; the “Zeitraum” chart shows a **loading skeleton** until the seed arrives (D10, throttled harness check 8m), visible “Datenstand”, canton design tokens/components (48 px controls), URL-backed store with **working browser back/forward (D6/D6a)**, comparison view + device-local Merkliste, cantonal “Nach oben”, Workers config + run book, unused vendor payload removed, D8 console classification |
| zurich-maps-2 | map, search, results/filters | ✅ own slippy map (no library) with clustering + WMTS overlays, swisstopo place search, time/collection/provider/viewport facets, decade histogram whose **bars count the filter scope (not the period) and whose drag-brush selects a range**, point filter (`at=`), “Ausschnitte” footprint layer (`ex=`), selectable Grundkarte (farbig/grau/Luftbild, `base=`), keyword search that folds the spelling (**“Zuerich” = “Zurich” = “Zürich”**, identical row counts — 168 of the 199 records just measured; ü→ue and ß→ss, plus diacritic-stripped “Genève”/“Geneve”), a map selection **bringing its own result row into view** (desktop split layout only — the phone counter-check asserts the page does not move), and the canton’s states under **`forced-colors`/Windows high contrast** (selected pin, selected row and selected decade keep a Highlight fill, an outline or a border instead of a background colour) — measured after my commit: `npm run check` **170/170** unit tests, harness **146/146** against `wrangler dev`, and **146/146** again from a fresh clone of the pushed `main` |
| zurich-maps-3 | detail view, IIIF, tests, harness | ✅ IIIF deep-zoom viewer + keyboard sheet strip + fullscreen + shareable cut-out (`vv=`), thumbnails fetched on demand, “Blatt” jump for large works, the panel’s own layer toggle for georeferenced swisstopo records, honest degraded-upstream states, series navigation; the comparison panes are the same viewer and are **coupled through each record’s documented extent** (`viewToExtent`/`extentToView`, switch `#compare-sync`); their **cut-outs are shareable state of their own** (`cvv=`, one pair per pane, D7) and each pane has its own “Ganzes Blatt”; **163 unit tests** (integrated tree incl. maps-2's spelling folding) and the **143-check** CDP harness (measured on the integrated tree, 2026-10-19) |

Integration gate as of 2026-10-19 (verified on this runner, 199-record seed):
`npm run check` (validation + the full `node --test` suite + `wrangler deploy --dry-run`);
`node scripts/browser-check.mjs` against `npx wrangler dev` (the count grows with every
teammate check — maps-3's line and each member's status file state the run they measured);
and `node scripts/verify:endpoints` for the upstream URLs (maps-0's line states the count
it last measured). A fresh clone (`git clone … && npm ci && npm run check`) passes on this
tree — the Cloudflare build path needs nothing but the repository.
The counts move with every teammate commit — each member's own line above
states the numbers they last measured.
