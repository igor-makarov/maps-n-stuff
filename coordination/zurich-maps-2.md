# zurich-maps-2 status

Iteration 4-6 (2026-10-18, UTC). Member `zurich-maps-2` (map, search, results).
Ownership per `coordination/README.md`: `public/app/map.js`,
`public/app/search.js`, `public/app/results.js` (plus the marker/result styles in
`public/styles/app.css`; the file is maps-1's, changes are listed below).

## Landed on `main` this iteration

| Commit | Content |
| --- | --- |
| `45ad3c2` | marker preview card, list↔map cross-highlight, "Alle Treffer einpassen" map button, selected-marker scale fix, empty-state reset button |

The empty-state change is in `results.js` only; the toolbar reset and the
empty-state reset now share `resetFilters()`, which restores the documented
initial view (`1816–1900`, clamped from the store defaults) instead of
`years.min–years.max` (which revealed the 2021 overlay records after a reset).

## First finding of this iteration: the module was dead again (not my commit)

`scripts/browser-check.mjs` failed its place-search check deterministically.
Root cause: `search.js` called `renderQuickLinks()` before `let quickLinks` was
initialised → `ReferenceError: Cannot access 'quickLinks' before initialization`;
`main.js` swallowed it, so the whole combobox (input listener, suggestions,
status, quick picks) was inert. **maps-3 fixed it in `6c18514` and maps-1 added
the visible `#app-notices` + `dataset.moduleErrors` machinery in `f0c954f` while
this iteration was starting**; my identical fix was dropped on rebase rather
than duplicated. `scripts/browser-check.mjs` now fails on any dead module
(`every UI module initialises`), so this class of bug cannot hide again.

## What the new map/list behaviour does (verified, not just written)

- Hovering or focusing a marker shows a card with the real e-rara thumbnail,
  publication year, title and holding institution, anchored above the marker and
  flipped/clamped inside the map; it is `aria-hidden` (decorative) because the
  marker's accessible name and the result list carry the same facts.
- A new bidirectional `record:preview` bus event cross-highlights: marker →
  result row and result row → marker. Both directions were driven in headless
  Chromium; the card is still open for a keyboard user when the mouse leaves.
- A third map-corner button (`aria-label` "Alle Treffer einpassen") fits all
  current results; it is the same code path as the `End` key and the chip below
  the map, and it writes `lat`/`lon`/`z` to the shareable URL.
- Selected markers scale again: `.map-marker.is-selected { transform: scale(1.25) }`
  never applied because `map.js` writes an inline `translate3d()`; the scale is
  now part of that inline transform, and the class adds a two-ring halo.

## Verified on the integrated `main` (2026-10-18 ~22:1x UTC)

- `npm run build` ✓ · `npm test` 52/52 ✓ · `wrangler deploy --dry-run` ✓
- `wrangler dev` (assets + `/api/*` worker) + `node scripts/browser-check.mjs`:
  **27/27 checks**, including the new `every UI module initialises`, quick picks,
  keyboard suggestion selection, and no console errors / failed requests.
- Manual CDP probes: preview card content + position, both cross-highlight
  directions, `scale(1.25)` in the selected marker transform, fit button URL
  change, empty state → reset → 34/42 · 1816–1900.
- Integration check of maps-0's new harvest (`88131d9`/`d80fb81`): 55 records,
  12 overlays; `ch.swisstopo.hiks-siegfried` appears in the comparison picker
  with 80 editions, defaults to the 1900 edition matching the time filter, and
  loads 16/16 real WMTS tiles (`…/hiks-siegfried/default/1900/3857/12/2143/1432.png`).

## Requests / messages

- **→ maps-3**: please add `coordination/zurich-maps-3.md` (the only missing
  status file) — your harness and fixes are excellent and worth recording; the
  README requires one file per member, and `main` is our only message bus.
- **→ maps-1**: the desktop map starts at ~740 px because the intro hero is
  ~600 px tall; on 390 px mobile the map/results need several screens of
  scrolling. If you want, I can make the intro collapse to a compact band once
  the user interacts (or link "Zur Karte" from the hero) — but it is your shell,
  so I have left it alone.
- **→ maps-0**: no new requests; the seed (42 records, 10 layers) is what the
  UI now assumes and the popover/preview only uses documented fields.
- **→ all**: `npm run check` stays the gate; the browser harness is the only
  thing that catches a module that throws during `init()`.

## Next (my area, if the loop continues)

- Time histogram above the year slider (distribution of the current result set,
  clickable bins with roving tabindex) for OldMapsOnline-like time browsing.
- Provider/type facet counts that follow the current time range instead of the
  whole corpus.
- Cluster markers only if the corpus grows well beyond ~200 records.
- Inspect the preview card with a screen reader order check and at 320 px width.
