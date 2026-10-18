# zurich-maps-1 status

Iteration 4-5 (2026-10-18 21:5x UTC). Shell/design-system/store/docs owner.

## Landed on `main` this iteration

| Commit | Content |
| --- | --- |
| `d55c95a` | `public/_headers` (CSP, nosniff, referrer/frame/permissions policy, cache lifetimes) + honest intro facts strip |
| `8febbcf` | `public/app/compare.js`: comparison list (`cmp` state key, sidebar panel, full-screen side-by-side view with real IIIF/WMTS previews, per-pane original-record links), `tests/compare.test.mjs`, and the `[hidden]` base fix below |
| (earlier) | `f0c954a`: optional-module failures are now visible (`#app-notices` + `document.documentElement.dataset.moduleErrors`) instead of a swallowed `console.warn` |
| (this batch) | mobile pass: map first on <1024 px, compact hero (cantonal 28 px h1 at the smallest breakpoint, 3-line lead + “Mehr über Bestand, Quellen und Rechte”), one scrollable row for quick picks and quick year ranges, short disclaimer in the top bar |

### The bug that mattered

`public/app/search.js` threw `ReferenceError: Cannot access 'quickLinks' before
initialization` during `init()`, so the **whole place-search combobox was absent
from the UI** (no suggestions, no quick-pick chips, no status line) while
`main.js` swallowed the error. maps-3 fixed the TDZ in `6c18514` and hardened
`browser-check.mjs`; I kept the regression visible by rendering a real notice
and keeping module errors in `ctx.moduleErrors` (the fix itself is theirs — the
duplicate in my commit was dropped on rebase).

### The bug my feature introduced (and the harness caught)

`.app-compare-view` sets `display: flex`; an author `display` beats the UA
`[hidden] { display: none }`, so the closed full-screen comparison view stayed in
the layout and swallowed *every* real mouse click. `scripts/browser-check.mjs`
turned red (`6/7, timeout waiting for detail panel`) while JS-only probes stayed
green — a good reminder that coordinate clicks catch what `element.click()` does
not. Fixed in the base layer (`zh-base.css`: `[hidden] { display: none !important }`),
re-verified 27/27.

## Verification evidence (2026-10-18 ~22:2x UTC, this runner)

- `npm run check` ✓ — validation, **57/57** `node --test`, `wrangler deploy
  --dry-run` (28.76 KiB Worker, `env.ASSETS` only).
- `node scripts/browser-check.mjs` **27/27** against `wrangler dev`: results,
  tiles, time range, detail + IIIF preview, overlay editions, place search and
  keyboard selection, `?sel=` deep links, contrast sweep, mobile, no console
  errors, no failed requests.
- focused comparison check **9/9** (own script, kept out of the repo): `?cmp=`
  link restores three pinned records, all pane images load (1200 px IIIF),
  clicked record first, focus management, Esc, `Auswählen` sets the shared
  selection, 390 px stacking without overflow.
- `curl -sI` shows the `_headers` values locally (CSP, `nosniff`, immutable
  fonts, 5 min app code); CSP causes no console errors in the harness.

### Mobile layout (measured at 390×844, this runner)

The map used to sit **8761 px** down the page (map first only in the sidebar
column): header + hero + 37 result rows came before it. `.app-mapwrap` now uses
`order: -1` below 1024 px (DOM order unchanged for screen readers), the hero is
compact, and the map starts at ~904 px — roughly one thumb-scroll, with no
horizontal overflow (0 px) at 390 and 360 px.

### Harness flake diagnosed, not papered over

`viewer pans with the arrow keys` failed in 2 of 4 harness runs. I measured the
real pan round-trip (three runs, `#viewer-stage` focused, two ArrowRight
presses): the region URL changed after 0.8 s, 0.8 s and 3.2 s — the viewer
debounces and then fetches the new IIIF region, so the fixed 1.8 s sleep was
simply too short. **maps-2 fixed the same flake in `283e48d` (with
`waitForViewer`) while I was measuring**; I dropped my duplicate patch on rebase
and kept their version. Two consecutive harness runs after the integration:
36/36 and 36/36 — no viewer flake since.

## Notes for the others

- **maps-3**: my `_headers` CSP sets `connect-src 'self'`; your `be824a6`
  (“fetch IIIF metadata through the Worker”) is exactly the right integration,
  thanks. If you ever add a client-side call to another host, extend both the
  CSP and `src/worker/allowlist.js` — not the other way round.
- **maps-2**: `results.js`/`map.js`/`search.js` remain yours; I only made the
  one-line TDZ-adjacent repair note above. The compare panel is additive markup
  at the end of the sidebar and never rewrites your DOM.
- **maps-0**: `public/_headers` and `scripts/validate.mjs` (I added `compare.js`
  to the syntax/asset checks and to the contracted UI hooks) are touched by me;
  everything else in `scripts/**` stays yours.
- **everyone**: `main.js` now keeps `ctx.moduleApis[name]` with each module's
  `init()` return value — handy for browser checks. And if your module renders a
  full-screen overlay, remember the base rule `[hidden] { display: none
  !important }`: an author `display` beats the `hidden` attribute.

## Messages

- **maps-0**: `public/app/records.js`, `public/data/**`, `scripts/harvest-seed.mjs`
  are yours and untouched by me except for review. The data contract holds; my
  `records.js` implements `loadRecords/loadSources/loadOverlays`,
  `filterRecords`, `recordsInBounds`, `sortRecords`, `facets`, `yearBounds` — if
  your version lands, keep those exports and the UI keeps working. Your worker
  handler body was not present in the tree, so I wrote one; replace/extend it as
  you like, but please keep `src/worker/allowlist.js` as the single allowlist
  (tests read it).
- **maps-2**: `map.js`, `search.js`, `results.js` on `main` are my provisional
  implementations behind the D4 contract (`ctx.store`, `ctx.bus`, `ctx.data`) and
  they work end to end (headless-verified). Replace them with your versions; the
  bus events available are `records:loaded`, `records:filtered`,
  `place:selected`, `record:selected`, `record:deselected`, `map:moved`,
  `overlay:changed`, `overlay:time`, `overlay:opacity`, `view:fit`. `map:moved`
  carries `bounds` (used by the viewport filter).
- **maps-3**: thanks — your Worker boot fix, `normaliseLon`, tests and site
  checks were rebased in and are on `main`. `detail.js` (mine, provisional) emits
  `record:deselected` on close and fits the extent via `view:fit`.

## Answers to maps-2 (iteration 3-5)

- **“Local fixture provider (tests only)” tag** – already fixed on `main`
  (`6a4b791`): `main.js` only renders providers that records actually use, so the
  `local` fixture entry no longer appears in the public intro.
- **`docs/` was empty** – now on `main`: `docs/run.md` (local preview, Cloudflare
  build settings, API, harvest, troubleshooting), `docs/design-system.md`
  (token-by-token derivation from the official repo) and `docs/data-sources.md`
  (primary record URLs, endpoints, rights, retrieval date, curl-verified CORS
  behaviour, publication vs depicted dates).
- **Your defects 3 and 4** (metadata layer, newest-edition default) are also
  fixed on `main` in my provisional `results.js` (metadata layers filtered;
  editions sorted oldest-first). Your “edition closest to the selected
  publication period” idea is better – take it over when you rewrite the file.
- **Your defect 5** (float dust in the URL): `stateToQuery` writes `lat`/`lon`
  with `toFixed(4)` and `store.js` keeps exact longitudes, so a pan no longer
  leaves `8.541700000000023` in the URL. If you still see dust, it is in your
  `map:moved` payload, not the store.
- **Ownership**: `map.js`, `search.js`, `results.js` are yours. My versions are
  provisional so the vertical slice worked from minute one; replace them freely –
  the bus events and `ctx` shape are listed in the messages section above.

## Final verification at the end of iteration 3-4 (2026-10-18 ~22:0x UTC)

- `node scripts/validate.mjs` ✓ · `npm test` 52/52 ✓ · `wrangler deploy --dry-run` ✓
  (28.76 KiB Worker upload, `env.ASSETS` binding only) — see `npm run check`.
- `wrangler dev` + headless Chromium (1440×1000, 390×844): 42 seed records
  (34 inside the default 1500–1900 range), swisstopo base tiles + Zeitreise
  overlay tiles load, swisstopo place search (8 hits), year/viewport/text
  filters, list/map/split views, IIIF detail preview, `Esc` close, keyboard focus
  ring (`3px #0070b4` on real Tab), URL state — **no console errors, no failed
  requests**.
- swisstopo WMTS records (added by maps-0) work in the detail view: real tile
  preview instead of a spinner, plus “Als Kartenebene einblenden” which sets
  `ov`/`ot` and swaps the comparison layer (12 tiles loaded in the check).

## Next steps (for whoever has time)

- Decode `commonjs`-style duplication: `public/vendor/leaflet` is currently
  unused — either wire it into `map.js` or delete it with a note.
- More seed records beyond the e-rara `zuz` set (the shell shows the count
  honestly); `ch.swisstopo.hiks-siegfried` is documented but not yet in
  `overlays.json`.
- `view` (split/map/list) is in the URL state but no control exposes it yet —
  add the three-way switch or drop the key.
- Screenshot/audit the mobile layout (390 px) after the merge.

## Blockers

- None. `GITHUB_TOKEN` from the Actions environment is required for `git push`;
  use a transient credential helper, never a stored secret (`main` pushes are
  working, non-forced, rebased).
