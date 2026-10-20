# Swarm coordination

> **Current loop (2026-10-20): `maps-n-stuff-sources-20261020`, three members.**
> This file is kept for the earlier `zurich-maps` design phase; its decisions
> (D1–D14) still describe the app's architecture and process rules. The status
> board at the bottom is **historical** (2026-10-19/20, 213-record Swiss seed)
> and is not current coverage. Authoritative sourcing status lives in
> `SOURCING_PROMPT.md`, `SOURCING_STEERING.md`,
> `coordination/sources-20261020-{0,1,2}.md` and `docs/data-sources.md`.
> On 2026-10-20 (runner clock 12:45 UTC) the merged product validated at
> **31,692 records** (7,536 core + 5 shards), 6 bundled providers plus 3
> withheld research scopes, 122 overlays and 54 history snapshots; `npm test`
> passed 287/287. The 31,692 tree includes the bounded USGS GeoPDF-only repair
> (55 unaligned original scans) published as `74f07942` and merged by member 0
> in `745e563d`. Doria, Leventhal/BPL and the Digital Commonwealth partner
> scope remain withheld under `research/withheld/` because no primary
> metadata-reuse licence was established; see
> `coordination/metadata-rights-decision-20261020.md`.

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
   something, add a new commit and explain it here. End the iteration with the
   workspace HEAD descending from your task branch (D12): when the task branch
   is behind `main`, add the merge commit (`git merge origin/main`) and push the
   same commit to both `main` and your task branch — otherwise Shurik's atomic
   publication is rejected and the iteration is recorded as a failure.
3. **File ownership beats merge luck.** Each path below has an owner. If you need
   a change in someone else's file, write it in your status file as a request and
   (if it is small and unblocking) make the change and note it — do not silently
   rewrite their module.
4. **Verify claims.** Notes here are evidence, not truth — check the code and the
   upstream sources before trusting them. Timestamps are UTC.
5. **Keep the app runnable.** `main` must always build/serve: `npx wrangler dev`
   (static assets + worker) and `npm test` (node's test runner, no deps).
6. **Delivery is an authenticated push.** The iteration job checks out with
   `persist-credentials: false`, so an unauthenticated `git push origin HEAD:main`
   fails with `could not read Username for 'https://github.com'` (fetch works:
   the repository reads anonymously). The job's `GITHUB_TOKEN`
   (`contents: write` in `shurik.yml`) works through a throwaway `GIT_ASKPASS`
   helper: a `/tmp` script that answers the username prompt with
   `x-access-token` and the password prompt with `"$GITHUB_TOKEN"`, with
   `GIT_TERMINAL_PROMPT=0`. The value stays in the job environment and is never
   written into the repository; the helper holds no secret. GitHub still refuses
   workflow-file changes made with the Actions token — product commits are not
   affected.

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
| D11 | 2026-10-19 | **“Ganzes Blatt” is a reset, not a gesture** (maps-2, `compare.js` + `detail.js`): with the comparison coupling on, one press of a pane's “Ganzes Blatt” returns **every live pane to its own whole sheet** and drops the shareable `cvv`, instead of the pressed sheet's place being mapped onto the others. That geographic mapping left the larger sheet on a cut-out whenever the pressed sheet's extent was the smaller one, so the documented promise depended on which extent contained which. `propagate()` is suppressed while the loop resets the panes, and the viewer's `reset()` reports its region immediately (`notifyView({ immediate: true })`) so the debounced report cannot re-couple a cut-out after the loop. Measured: `?cmp=e-rara:8562848,e-rara:7246431`, zoom pane 1 twice, reset it → both read “Gesamtansicht”, `cvv` empty, both reset buttons disabled. |
| D12 | 2026-10-19 | **An iteration must end with the coding-tool workspace on a commit that descends from the member's task branch** (process; maps-0 after diagnosing the repeated “Actions run ended before final publication”). Shurik publishes the workspace's `HEAD` atomically as `<HEAD>:refs/heads/<member>` together with the control-branch update; an iteration that leaves the workspace on `main` (`9deeed5`) while `origin/<member>` still points at the older brief commit (`f71d600`) is rejected — measured in `diagnostics/recovery/39193419868-1.json`: `! [rejected] 9deeed5… -> zurich-maps-0 (non-fast-forward)`. The atomic control transaction then fails after five attempts, the job reports failure and the recovery job restores the last checkpoint, while the product commits survive on `main` — that is exactly why 7-20 … 7-22 all ended “interrupted (failure)”. Remedy used in 7-23: commit on the task branch (or merge `origin/main` into it), then push the **same** commit to `main` and to the task branch, so both refs stay fast-forwardable (`7fe9472`). Never rewrite either ref. If your task branch is not an ancestor of `main` (maps-2 after `ebbc66b`), that merge is also what makes the publication fast-forward. |
| D13 | 2026-10-19 | **The comparison coupling switch is shareable state of its own** (`csync`, maps-1 in `store.js`/`compare.js`): coupled is the documented default and stays out of the link, so a comparison link written by the app carries `csync` only when the visitor deliberately uncoupled the panes (`csync=0`); such a link reopens the panes decoupled, the sync hint says so instead of promising a coupling, and one press of the switch couples them again and removes the parameter. Like `cvv`, `csync` replaces the current history entry rather than opening one (D6/D7) — the visitor's exploration stays the history, the shared view stays in the link. Guarded by `tests/compare.test.mjs` (default, junk values, round-trip together with `cmp`/`cvv`) and harness section **8c5**, which also pins the dialog's keyboard behaviour (focus starts on “Schliessen”, Tab from the last control wraps to the first, Escape hands focus back to the toolbar button). |

| D14 | 2026-10-19 | **Post-redirect lanes, claimed by maps-2 on the bus (the brief's redirect supersedes the German/Swiss-first decisions).** Declared here so four agents do not build the same feature twice. **maps-2**: the missing *historical-borders* map — a reproducible pipeline for the world-boundary snapshots plus the renderer, year/timeline control and clickable polity details — and the **global** basemap + **worldwide place search** (the swisstopo-only defaults go). **maps-1**: English chrome end to end (shell, copy, social metadata) and the *original identity*: one English product name + atlas-themed logo, with the canton shield/flag mark removed from header and favicon. **maps-0**: global archival sources (LoC / BnF Gallica / NLS / David Rumsey / e-rara) in the seed + the source registry, and a provenance review of the history dataset. **maps-3**: harness/unit-test coverage for the three correction outcomes and the detail view. Data decisions of this row: historical polygons from **aourednik/historical-basemaps** (GeoJSON snapshots 8000 BCE–1994 CE, GPL-3.0 — bundled with its licence, upstream revision and our simplification recorded); the history basemap is **NASA GIBS** imagery (public domain, physical relief, *no modern political borders*) with an opt-in OpenStreetMap reference layer; the global basemap and place search are **OpenStreetMap / Nominatim** (ODbL) reached through the Worker's allowlist. If another member already started one of these, say so in your own status file and we integrate rather than duplicate. **Convergence (maps-2, 05:40 UTC, after maps-3's `1c56218`):** maps-3 claimed the History *view* (own route `public/history.html`, renderer, History URL state) — accepted, the renderer is theirs. maps-2 keeps the **data half**: `scripts/fetch-history.mjs` + the bundled `public/data/history/` snapshots with the provenance index, and hands maps-3 a frozen schema (`index.json` + `world_<year>.json`, fields `n/s/p/b/r` + quantised int rings). maps-3 renders whichever pipeline lands first; if they have one in flight they should publish its schema in their status file instead and maps-2 will consume it. |

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
| zurich-maps-0 | worker proxy, records seed + source registry | ✅ **213 records**: e-rara OAI-PMH/IIIF (26 ZB Wildkarte sheets, **56** ETH `landkarten` sheets — the 7-19 widening reads 30 of the set's 2335 records, pools 125 candidates and keeps the union of the oldest 26 and a per-decade spread, so the set now spans **1547–1900** —, **47** Zürich plans + 11 Zürich-region + 10 city ground/site plans + **35** Europe/world/country overview maps via SRU 1.2 (**twenty** questions since 7-21: continent keywords, Deutschland/Italien/Frankreich/… and eight non-European regions, pooled in rounds with a 7-per-keyword quota; the 7-21 hemisphere fix reads `W`/`S` corners too, so the set is global — 1546–1914), 1 Genf) + 27 swisstopo overlay editions; seed spans **1546–2021** (the whole-globe sheets' own extent; 172 → 186 e-rara records since 7-21); canton-window (mirrored for the world set), per-decade and `zuz`-first selection rules, holding library never defaulted, keyword search covers collection/imprint, `npm run verify:endpoints` (maps-0's line states the last measured count; the script retries transient 429/5xx because e-rara's DOI pages throttle), `docs/data-sources.md` + `sources.json` registry; the seed reproduces from a **cold** cache (1153 responses, 2026-10-19) and every promised URL answered 200 (**984/984, 0 retries**, 2026-10-19) |
| zurich-maps-1 | shell, design system, store, wrangler, docs, compare | ✅ map-first compact shell incl. the **phone step** and honest **loading/seed-outage states**: hero figures move to “Über das Projekt” below 600 px, and since 7-19 the **very-small-phone step (D9, ≤ 399 px)** spends the first screen on the map — 320×640 658 → 507 px (0 → 133 px visible), 390×844 609 → 483 px (361 px visible) — while the design note/lead leave copies in “Über das Projekt”/the footer; the “Zeitraum” chart shows a **loading skeleton** until the seed arrives (D10, throttled harness check 8m), visible “Datenstand”, canton design tokens/components (48 px controls), URL-backed store with **working browser back/forward (D6/D6a)**, comparison view + device-local Merkliste with a **shareable coupling switch** (`csync=0`, D13 — a decoupled comparison link reopens decoupled and the switch couples it again), cantonal “Nach oben”, Workers config + run book, unused vendor payload removed, D8 console classification |
| zurich-maps-2 | map, search, results/filters | ✅ own slippy map (no library) with clustering + WMTS overlays, swisstopo place search, time/collection/provider/viewport facets, decade histogram whose **bars count the filter scope (not the period) and whose drag-brush selects a range**, point filter (`at=`), “Ausschnitte” footprint layer (`ex=`), selectable Grundkarte (farbig/grau/Luftbild, `base=`), keyword search that folds the spelling (**“Zuerich” = “Zurich” = “Zürich”**, identical row counts — 168 of the 199 records just measured; ü→ue and ß→ss, plus diacritic-stripped “Genève”/“Geneve”), a map selection **bringing its own result row into view** (desktop split layout only — the phone counter-check asserts the page does not move) **and announcing it in the list's live region** (`Zeile N von M ausgewählt: <Titel>`, with the “list scrolled” clause exactly where the page moved), and the canton’s states under **`forced-colors`/Windows high contrast** (selected pin, selected row and selected decade keep a Highlight fill, an outline or a border instead of a background colour; a real **brushed decade range** keeps its Highlight bar and its outline, measured with the panel closed because its scrim swallowed the first real drag) — plus the repair from the interrupted 7-21 delivery: a coupled “Ganzes Blatt” returns every pane to its own whole sheet (the reset sheet’s place is no longer mapped onto the others) — see this file for the measured counts |
| zurich-maps-3 | detail view, IIIF, tests, harness | ✅ IIIF deep-zoom viewer + keyboard sheet strip + fullscreen + shareable cut-out (`vv=`), thumbnails fetched on demand, “Blatt” jump for large works, the panel’s own layer toggle for georeferenced swisstopo records, honest degraded-upstream states, series navigation; the comparison panes are the same viewer and are **coupled through each record’s documented extent** (`viewToExtent`/`extentToView`, switch `#compare-sync`); their **cut-outs are shareable state of their own** (`cvv=`, one pair per pane, D7) and each pane has its own “Ganzes Blatt”; a pair whose documented extents never meet (a world map next to a distant plan — the seed since `b65e7b0`) is not silently coupled either: the pane that cannot show the cut-out keeps its own whole sheet and says so (`data-coverage="outside"`), the hint names the pane and the reason, and the shareable `cvv` carries only the pane that really shows a region (maps-1's `coupledView`/`intersectExtents`); **180 unit tests** (integrated tree incl. maps-2's spelling folding and maps-1's three `csync` cases) and the **155-check** CDP harness (measured on the integrated tree, 2026-10-19) |

Integration gate as of 2026-10-19 (verified on this runner, 213-record seed):
`npm run check` (validation + the full `node --test` suite + `wrangler deploy --dry-run`);
`node scripts/browser-check.mjs` against `npx wrangler dev` (the count grows with every
teammate check — maps-3's line and each member's status file state the run they measured);
and `node scripts/verify:endpoints` for the upstream URLs (maps-0's line states the count
it last measured — **984/984 URLs, 0 failures** on 2026-10-19). A fresh clone (`git clone … && npm ci && npm run check`) passes on this
tree — the Cloudflare build path needs nothing but the repository.
The counts move with every teammate commit — each member's own line above
states the numbers they last measured.
