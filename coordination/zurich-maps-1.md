# zurich-maps-1 status

Iteration 7-18 (2026-10-19 ~01:45–02:0x UTC). Shell/design-system/store/wrangler/
docs/compare owner. Newest entry first; earlier iterations are kept below.

## Iteration 7-19 — 320 px gets the map on the first screen, and the loading chart says so

Shell/design-system/store/wrangler/docs/compare owner. Two shell gaps from my own
open list, one small repair in maps-3's stylesheet, and the harness checks that
pin both down.

### 1. Very small phones (≤ 399 px): 0 → 133 px of map at 320×640

Measured at the start of the iteration on the 199-record tree (headless
Chromium, this runner): 320×640 put the map top at **658 px** — header 242 +
hero 242 + toolbar 151 — so the smallest phones saw no map at all, and the
390×844 case stood at 609 px / 235 px visible. Four blocks now yield below the
cantonal 400 px breakpoint; every one of them still reads elsewhere on the page:

| Block | Height | Where the content stays |
| --- | --- | --- |
| `.zh-header__note` (“Gestaltung nach dem Designsystem … unabhängiges Projekt”) | 34 px | verbatim in “Über das Projekt”; the footer names the canton as the design reference; the nav links in the same black bar stay |
| `.app-intro__lead-short` | 72 px | the same sentence is the first “Über das Projekt” paragraph |
| `.app-intro__more` (“Quellen & Rechte · Zur Karte”) | 44 px | `#about`/`#sources` are in the header nav; the map is directly below |
| `#place-quick > .zh-hint` (“Schnellauswahl:”) | row | group keeps `aria-label="Schnellauswahl Orte"`; the chips get the full row, so the last chip is no longer cut in half |

| Viewport | map top before | map top now | visible map |
| --- | --- | --- | --- |
| 320×640 | 658 px | **507 px** | 0 → **133 px** |
| 360×740 | — | 483 px | 257 px |
| 390×844 | 609 px | **483 px** | 235 → **361 px** |
| 414×896 | 615 px | 615 px (untouched) | 281 px |

No horizontal overflow at any of the four widths (0 px). ≥ 400 px is unchanged,
so desktop/tablet keep the full intro band. Decision **D9** in
`coordination/README.md`; the derivation is in `docs/design-system.md` (“Very
small phones”), the run book and README carry the new numbers.

### 2. Honest loading: the “Zeitraum” chart is no longer an empty box

`results.js` can only build the decade chart from the records, so while the
seed was in flight the fieldset showed a 56 px empty chart above its hint
(the open item of 7-17). `app.css` now gives `#year-histogram:empty` a
“Jahresverteilung lädt …” line and a faint hatch — but **only** while the
shell's own loading state holds:

```css
.app-side:has(#result-list[aria-busy='true']) #year-histogram:empty { … }
```

That ties the skeleton to `#results-loading`/`aria-busy` (`main.js`
`finishLoading()`), so it also disappears in the seed-outage case, where
`results.js` never runs. Decision **D10**. Presentational only: a browser
without `:has()` shows what it showed before.

### 3. Small repair in maps-3's `detail.css` (noted, no visual change)

The dead fallbacks from my 7-13 note are gone: `var(--zh-font-tiny, 0.8125rem)`
→ `12px` (4×) and `var(--zh-line-medium, 1.45)` → `1.3` — the tokens exist and
their real values are 12 px / 1.3. No visual effect while the tokens exist; the
file no longer lies about them.

### 4. Harness (maps-3's file, additive, noted)

- The 7-18 check “the phone lead ends as a complete sentence at 390 and 320 px”
  is **replaced** by the check for the new rule: below 400 px the hero lead is
  not displayed, and the sentence reads complete (ends on “.”) in
  `#about [data-record-count]`'s paragraph at 390 **and** 320. The old check
  would have gone red for the wrong reason (it required the short variant to be
  visible); the new one asserts the decision and its fallback.
- New: “the map starts on the first screen at 320×640 as well”
  (mapVisible > 100 — measured 133 — and no overflow).
- New (section 8m): “a slow seed shows the loading state and a year-chart
  skeleton instead of an empty box” — throttles CDP to 20 kB/s + 2 s latency
  with the cache disabled, waits for `#results-loading`/`aria-busy` **and** a
  parsed `app.css` (the throttled nav also slows the stylesheet down; without
  that wait the check read the pre-CSS page and reported `skeleton: none` — the
  first run of the check failed for exactly that reason and the check now waits
  for the real condition instead of a sleep), then asserts the skeleton line,
  the loading texts and no overflow. **148/148** checks on the rebased tree
  (146 from the other members, minus my replaced 7-18 check, plus my two new
  ones).

### Evidence (this runner, 2026-10-19 ~02:3x–03:0x UTC, rebased on `main`)

- `npm ci` ✓ · `npm run check` → validation ✓, **170/170** `node --test` (the
  rebased tree includes maps-2's reveal/high-contrast work and their tests),
  `wrangler deploy --dry-run` ✓ (31 asset files, 28.76 KiB Worker, `env.ASSETS`
  only).
- `node scripts/browser-check.mjs` → **148/148** on the rebased tree (the first
  run of the new check on my own tree was 144/145:
  the skeleton check fired before the throttled stylesheet had parsed; fixed in
  the check, not by a sleep — see above); the integrated run also carries
  maps-2's pin-reveal and forced-colors checks.
- Probes (kept out of the repo, in `/tmp`): `probe719.mjs` (four phone widths,
  loading + outage states, screenshots), `probe-loading.mjs` (focused 8m
  reproduction).
- The `#place-quick` row still scrolls horizontally at 320 px (the four chips
  are ~331 px wide in a 296 px row), but with the caption gone three of them
  are fully readable and the fourth is no longer cut at its first letter. A
  wrap to two rows would cost ~40 px of map; left as a deliberate trade-off.

### Messages

- **→ maps-3 (harness + `detail.css`)**: the three changes above are
  additive/replacement within my own sections; the `detail.css` fix is the
  dead-fallback note from 7-13, textual only. The 8m check lives just before
  your section 9 and restores the network conditions and the cache flag after
  itself; it does not touch your checks.
- **→ maps-2**: nothing in `map.js`/`search.js`/`results.js` changed. The
  skeleton keys off your `#result-list[aria-busy]` contract (D10) and is
  CSS-only, so it disappears by itself when you fill the chart. I also checked
  the open note from 7-17: `results.js` **does** have a per-thumbnail `error`
  fallback now (`records.js`-driven placeholder) — that item is closed on my
  side.
- **→ maps-0**: your 199→206-record widening landed while I measured; the
  harness thresholds in my checks are count-independent (map geometry, loading
  state), and the final run is on the rebased tree.
- **→ all**: `npm run check` + `node scripts/browser-check.mjs` stay the gate.
  If you add content to the hero band below 400 px, read D9 first — the band
  deliberately hides its lead/links there.

### Open (updated)

- `#place-quick` at 320 px: scrolls horizontally (see trade-off above).
- The filter panel says nothing about the *map* while tiles are slow: the map
  has its own skeleton row of tiles; the skip list is usable meanwhile. No
  reported defect.
- `compare.js` (mine) has no automated check for its focus trap; the harness
  covers Esc/focus for the detail panel. A comparison-view keyboard check would
  be the next thing I would add.

## Iteration 7-18 — histories joined, the conflict marker is gone, the phone lead ends on a full stop

### 0. Recovery: the branch was 18 commits behind `main`

`origin/zurich-maps-1` still pointed at `5e3913b` (7-16), while `main` had
integrated the same two commits as `fba1f86`/`6948507` and moved on (169-record
seed, cluster point piles, loading/outage states, docs). I verified that every
change of my two commits is present on `main` (per-file diff, no line of mine
lost; the apparent deletions were teammates' later rewordings, e.g. the outage
message and `HISTORY_TEXT_KEYS`) and then **joined the histories instead of
rewriting the task branch**: `8121039` and `4db9687` are merge commits whose tree
is exactly `origin/main`'s, so pushes to `main` *and* to `zurich-maps-1`
fast-forward. Teammates' commits are untouched; no force-push anywhere.

A real artefact from the interrupted 7-17 rebase had reached `main`:
`docs/run.md` carried a literal `>>>>>>> f9f305e …` line between the harness row
and the Cloudflare section (maps-2 then edited the same row, which is how it
survived). Removed, blank line restored; the whole tree was grepped for markers.

### 1. Phone hero: the lead was cut mid-word at every width below 600 px

Screenshot/measurement of the integrated tree (`/tmp/measure-phone.mjs`, scratch
CDP probe): the lead paragraph needed 4 lines at 430 px and 8 lines at 320 px,
but the ≤599 px rule clamped it to 2 — so every phone ended in “…
Vergleichsebene und” or “… aus…”. Fix: `.app-intro__lead-short`, a second,
complete sentence for phones (“Der Bestand umfasst <n> Karten und Atlanten aus
echten Sammlungen.”) that the existing count node fills via `[data-record-count]`;
the clamp moves to 3 lines as a safety net only. The long desktop sentence is
unchanged, and the `<span>`s are `display:none` on the other side of 600 px, so
the accessibility tree only ever shows one.

| Width | lead before (visible / needed) | lead after | map top / visible |
| --- | --- | --- | --- |
| 320×844 | 2 lines, clamped, scrollHeight 202 px | 3 lines, ends on “.” | 633 → 658 px / 211 → 186 px |
| 390×844 | 2 lines, clamped, scrollHeight 151 px | 2 lines, ends on “.” | 609 px / 235 px (unchanged) |
| 430×844 | 2 lines, clamped, scrollHeight 126 px | 2 lines, ends on “.” | 587 px / 257 px (unchanged) |
| 600 px | not clamped (4 lines) | unchanged | unchanged |

New harness check “the phone lead ends as a complete sentence at 390 and 320 px”
(short variant visible, long one hidden, `scrollHeight === clientHeight`, text
ends on a full stop, no overflow). Harness: **139 checks**.

### 2. Tooling repair (D8): an upstream outage is evidence, not a failure

The first full harness run of this iteration was **138/139**: the only failure
was the console-hygiene check, with 42 browser log entries
`Failed to load resource: net::ERR_CONNECTION_REFUSED https://www.e-rara.ch/i3f/…`.
`curl` confirmed e-rara was refusing connections from the runner (an outage, and
the third time this file records e-rara throttling: maps-0 measured 429/5xx
retries, the run book documents them). The app had degraded exactly as designed
(its image-fallback checks passed). The check now classifies browser-level
`net::ERR_(CONNECTION|NAME|TIMED_OUT|…)_` entries for **external** origins into
`report.upstreamConsoleErrors` (kept as evidence, printed as an ℹ line), while
our own origin, our own exceptions and the deliberate `ERR_BLOCKED_BY_CLIENT`
assertions still fail. Recorded as decision **D8** in `coordination/README.md` (maps-3 had already claimed D7 for the comparison panes’ shareable cut-outs, which is why this is D8);
`docs/run.md` troubleshooting has the reader-facing version. Re-run: **139/139**.

### 3. Evidence (this runner, 2026-10-19)

- `npm ci` ✓ · `npm run check` → validation ✓, **149/149** `node --test`,
  `wrangler deploy --dry-run` ✓ (28.76 KiB Worker, `env.ASSETS` only).
- `node scripts/browser-check.mjs --url http://127.0.0.1:8787` → **139/139**
  (first run 138/139, failure explained above; screenshots + `report.json`).
- `README.md`, `docs/design-system.md`, `docs/run.md` describe the phone lead
  variant and the D8 classification; the Cloudflare build settings section is
  unchanged and still current.
- Two integrations while other members were pushing: `f3543b5` (maps-2's
  spelling folding + maps-3's `cvv` per-pane cut-outs, D7 → my decision became
  D8) and the following merge (maps-0's 199-record widening of the ETH
  `landkarten` set). Same rule every time: their newer row wins, my facts are
  spliced in, then re-verified — **163/163** unit tests, `wrangler deploy
  --dry-run`, **143/143** harness checks on the merged 199-record tree.
- Scratch probe (not committed): `/tmp/measure-phone.mjs`.

### Open (unchanged from 7-17, plus)

- 320 px: header ≈ 242 px + hero ≈ 242 px still put the map at 658 px of a
  640 px screen; the map peeks on a 844 px-tall phone (186 px visible). The
  quick-pick chips scroll horizontally in a one-line row (`overflow-x: auto`) —
  usable, but the cut chip at the right edge is the next thing to polish.
- `results.js` (maps-2): result thumbnails have no per-image fallback, so a
  down partner library shows browser broken-image placeholders in the list
  (the detail panel has one; the harness's hostile section only covers the
  panel).
- The filter panel's histogram/year area is visually empty while the seed loads
  (maps-2); the shell says “Bestand wird geladen …” and marks the list busy.

---


## Iteration 7-16 — the map starts on the phone screen, and the seed says when it was harvested

### 1. The phone step of the map-first shell (my file, reconciled with maps-0)

The map-first shell was only half done: at 390×844 the map began at 722 px, so a
phone visitor saw a 122 px strip of map under header, hero and toolbar. The hero
“Zahlen und Fakten” strip was the largest movable block.

| Change | File | Effect (measured, headless Chromium) |
| --- | --- | --- |
| Below 600 px the hero hands its stock figures to “Über das Projekt”: `#about-facts` is filled from the **same** render path in `main.js` (one facts builder, two hosts, cloned nodes), so the numbers stay on the page — they simply no longer stand between the visitor and the map. | `index.html`, `main.js`, `app.css` | 390×844: map top **722 → 609 px**, visible map **122 → 235 px**; 320×640: 767 → 633 px (the map starts to peek); desktop ≥600 unchanged (1440: 612 px) |
| Hero/shell paddings drop one cantonal step at ≤599 px (`--zh-size-tiny` instead of `--zh-size-small-regular`), toolbar margin likewise; the two phone link labels are shortened (“Quellen & Rechte · Zur Karte”). | `app.css`, `index.html` | ~35 px of the total |
| Below the cantonal 400 px breakpoint the brand claim is hidden (the name stays; the claim repeats the page title and is in the meta description). | `app.css` | 320 px: one header line |
| No horizontal overflow at any tested width; the harness check asserts it. | `app.css` | 320/390/1440: 0 px |

**Reconciled, not reverted:** maps-0 had fixed the same strip the other way
(da11385, two-column grid instead of the clipped scroll row) while I was working.
Their readability fix is **kept** and now applies to the visible `#about-facts`
list (two columns on a phone); only the *hero* host is hidden there, because a
two-row strip made the first phone screen 55 px taller again. Their measured
values, layout reason and grid rule are untouched in `app.css`.

### 2. Honest provenance: “Datenstand”

`records.json.generatedAt` is now visible in “Quellen und Rechte” as
“Datenstand: TT.MM.JJJJ · Herkunft und Rechte je Anbieter siehe
Quellenregister”. It is read from the data file, never from the visitor's clock,
and stays hidden when the field is absent. The seed's harvest date was otherwise
only in the docs and the console line.

### 3. New harness check (maps-3's file, additive, section 8f)

`phone map-first: the map starts on the first screen and the stock figures stay
in “Über das Projekt”` — at 390×844 (the same page load as the heading-curve
check, so no extra navigation) it asserts `mapVisible > 180` (measured 235),
`#about-facts` has ≥4 visible items, the hero strip is `display: none`, and the
document does not overflow. Screenshot `03d-mobile-mapfirst.png`. The integrated
harness is **127/127** after the rebase over da11385/971ce2f/6eef9ba.

### Verified (this runner, 2026-10-19 ~01:2x UTC)

- `npm run check` ✓ — validation, **136/136** `node --test` (the rebased tree
  includes maps-2's Grundkarte and maps-3's compare coupling), `wrangler deploy
  --dry-run` (30 asset files, 28.76 KiB Worker).
- `node scripts/browser-check.mjs` → **127/127** against `wrangler dev` on the
  rebased tree (126 checks from teammates + mine), no console errors, no failed
  requests; screenshots in `/tmp/shots-716r`.
- Rebase conflicts resolved by hand in `app.css` (see “Reconciled” above),
  `README.md` (kept maps-2's new `base` URL key next to my phone-step text) and
  `docs/run.md` (kept maps-3's 126-check description and added the phone step →
  127). No teammate's commit was reverted.

### Messages

- **→ maps-0 (your da11385 in my file)**: thank you — the clipped-strip diagnosis
  was right, and your two-column grid is kept for `#about-facts`. I then hid only
  the *hero* host at ≤599 px because the two-row strip added ~55 px back to the
  first phone screen; the same four figures are now in the About card, filled
  from the same data path, so nothing is lost. If you would rather keep the strip
  in the hero on phones, say so and I will revert my part — the harness check I
  added names the trade-off explicitly.
- **→ maps-2**: nothing of `map.js`/`search.js`/`results.js` touched. The store
  keeps `base` as a replace-only key (I checked: it is in the default set and not
  in `HISTORY_PUSH_KEYS`), so switching the Grundkarte does not create history
  steps.
- **→ maps-3**: one additive check in section 8f of `browser-check.mjs` (right
  after the heading-curve check, reusing its page load) and one screenshot.
  `docs/run.md`'s harness description now says 127; your compare-coupling text and
  the 65-sheet wording are preserved.
- **→ all**: the phone step is a documented shell decision (`docs/design-system.md`
  “Phone step (app decision)”). The harness gate stays `npm run check` +
  `node scripts/browser-check.mjs`.

### Next (my area)

- 320×640 is still 633 px to the map: the remaining blocks are the header
  (242 px: note, nav, brand, search, quick picks) and the toolbar (151 px, three
  rows). A real further step would have to touch `search.js`'s quick picks or
  collapse the toolbar; both need their owners' agreement.
- `detail.css:117` still carries the dead `--zh-line-medium` fallback noted in
  7-13 (maps-3's file, no visual effect).

## Iteration 7-14 — the browser's back button now walks the exploration

The URL is our state (D4), but pressing back left the app: the store only ever
called `replaceState`, so the first “back” went to whatever page the visitor came
from. Measured before the fix with a real Chromium (this runner):

```
start          { url: '/?from=1754', entries: 2 }
after select   { url: '/?from=1754&…&sel=e-rara%3A29362556', entries: 2 }
after back #1  { url: 'about:blank' }          ← out of the app, work lost
```

| Commit | Content |
| --- | --- |
| `store.js` | **History navigation (D6).** `HISTORY_PUSH_KEYS` = `q, from, to, provider, type, collection, viewport, at, place, selected` open an entry; every other key (`lat, lon, zoom, sheet, view, sort, overlay, otime, cmp`) replaces it. Same key set inside `HISTORY_COALESCE_MS` (900 ms) merges, so typing and dragging are one step each. `popstate` re-reads the URL and notifies modules with the same `(state, changedKeys)` shape as `update()`; the URL is only written when it really changes; the `#fragment` survives. New `applyUrl()` and an injectable `now()` clock for tests. |
| `store.js` | Two guard rails so the app's own work never eats a step: the year range is clamped to the data right after the records arrive, and a view may write a clamped `sheet` back — both now `replaceState`, because nothing pushes before the first real interaction (`pointerdown`/`keydown`/`touchstart`/`click`, the last one captured so a bare `el.click()` counts). |
| `detail.js` (maps-3's file, 12 lines, noted in my messages) | **Bug found by the new check:** nothing closed the panel when `selected` was cleared from the outside (the browser's back button, a shared link, the series lead), and the panel did not re-open when the URL named another record. The store subscription now closes/re-opens for `selected`, and the `record:selected` bus handler skips a record that is already on screen (no second manifest load). `close()` is unchanged: it still keeps the selection, because the comparison list's «hinzufügen» action and the harness rely on “select → close → pin”. |
| `tests/history.test.mjs` | **10 new tests** (111 total) with a fake `history`/`location`/`window` and a hand-cranked clock: push vs replace per key set, coalescing (including a gesture longer than the window), bare-click interaction, start-up repair, popstate back/forward, no-op writes, fragment, junk URL, and no-`history` fallback. |
| `scripts/browser-check.mjs` (maps-3's file, additive section 8l, noted) | **7 new checks** (97 total): the app adds no history entry while it starts up, forward restores it, opening a record is undoable, back closes it and keeps the search, forward re-opens it, a map drag is not a step, and one “back” undoes a whole typed search. Uses real mouse events and `history.back()` instead of counting `history.length` (browsers clamp it). Two small repairs in the same file: the pinned/selected id is read from `#result-list button[data-record-id]` (the `<li>` wrapper has no id, so `selectedRecord` was always `null`), and the “detail selection is shareable” assertion moved next to the `?sel=` link checks. |
| `README.md`, `docs/run.md`, `coordination/README.md` | Feature list, a new “Browser history (back/forward)” table in the run book, 111 tests / 97 checks, status board refreshed to the real 98-record seed, decision **D6**. |

### Verified (this runner, 2026-10-18 23:5x UTC)

- `npm run check` ✓ — validation, **111/111** `node --test`, `wrangler deploy
  --dry-run` (30 asset files, 28.76 KiB worker).
- `node scripts/browser-check.mjs` → **97/97** against `wrangler dev`
  (90 before this iteration, plus my 7 new checks in section 8l).
- Behaviour after the fix, same probe: `start entries 2` (no start-up entry),
  select → `3`, back → `/?from=1754` with the list intact, year change → push,
  back → `?from=1754` (80 rows), forward → `?from=1794` (71 rows).
- Mobile/desktop layout, contrast sweep, degraded-upstream, compare, series and
  the whole existing harness stay green in the same run; screenshots in
  `/tmp/shots-714f`.

### Messages

- **→ maps-3 (harness + `detail.js`)**: I added section **8l** to your
  `browser-check.mjs` (before the console-hygiene block, self-contained with real
  mouse events), changed the “detail selection is shareable” assertion to match
  the `?sel=` checks, and made `detail.js` follow `selected` in both directions
  (close on clear, re-open on a URL that names another record). `close()` itself
  is untouched. Two lines of your harness are repaired: the selected id now comes
  from the row's button, not its `<li>`. Revert/reword freely — the ids my checks
  assert are `#result-list button[data-record-id]`, `#detail`, `#text-filter`,
  `#map`.
- **→ maps-2**: nothing in `map.js`/`search.js`/`results.js` changed. Your
  debounced `push()` in `map.js` writes only `lat/lon/zoom`, which are
  replace-only keys, so a pan cannot create a step — the check “a map drag
  replaces the entry instead of adding history steps” pins that down. If you ever
  add a *deliberate* action that should be undoable, use a key from
  `HISTORY_PUSH_KEYS` or call `ctx.store.update(patch, { history: 'push' })`.
- **→ maps-0**: no data change; the harness now reads the selected record's id
  from the DOM, so the checks that compare against `recordIndex` finally do what
  they were written to do.
- **→ all**: `npm run check` + `node scripts/browser-check.mjs` stay the gate.
  Nothing about the Workers config, the asset set or the CSP changed.
- **→ all (D6 reminder)**: do not write store state during start-up unless it is
  a `replace`-only key, and never re-introduce a selection-clearing path without
  telling `detail.js` — it now follows `selected`.

## Iteration 7-13 — controls follow the cantonal scale, unused payload gone

| Commit | Content |
| --- | --- |
| `70192ec` | **cleanup: the unused vendored Leaflet copy is removed** (7 files, 192 KiB). Nothing referenced `public/vendor/leaflet` — not `map.js` (own slippy map), not the HTML/CSS, not the harness (grep-verified). `NOTICE.md` lost its Leaflet row, `README.md` its “vendored but unused” limitation; coordination **D5** records the decision. The deployed asset set is now 30 files (was 40) and every one of them is used. |
| `9bf7583` | **design system: control height corrected to the official 48 px** and re-verified against the upstream files. See below. |
| `(this commit)` | **shell: cantonal “Nach oben” control** (`mdl-back2top`): 48 px circle with the 24 px arrow, fixed bottom-right with the upstream margin curve, hidden until the page is scrolled, click scrolls to the top and moves focus to `#main`. One additive harness check; the integrated harness is **90/90** after rebasing over maps-3's fullscreen/degraded-upstream checks and maps-2's point filter (two rebase rounds, conflicts in `browser-check.mjs`/`docs/run.md` resolved by keeping both sides' checks and facts). |
| (in `70192ec`) | `docs/run.md` harness count 71 → 72 (incl. “Suchlink kopieren”); `coordination/README.md` status board now states the real iteration-7-13 state of all four members instead of “scaffold in progress”. |

### The arithmetic error this iteration found and fixed

Upstream (commit `552ceb6`, read 2026-10-18) says
`$normalButtonSize: $sizeBiggerBig + $sizeTiny;` — 40 + 8 = **48 px**, the height
of `.atm-button` — and `form_input.scss` builds inputs on the 72 / 60 / 48 px
scale. Our buttons/inputs were 40 px tall and `docs/design-system.md` repeated
the wrong arithmetic (“fixed 40 px (`$sizeBiggerBig + $sizeTiny`)”). Now:
`--zh-control-height: 48px` (button min-height/min-width, icon buttons, map
controls, header search), `--zh-control-height-small: 32px` (`$sizeBig`, the
official `.atm-button--small`), inputs get the upstream 2 px radius.

Two deliberate app decisions are documented instead of hidden: the
sidebar/toolbar fields keep a **32 px** compact step (our own, for a data-dense
sidebar) and the input border stays **black**, because the upstream `#949494`
boundary is only 2.9:1 on white while SC 1.4.11 asks for 3:1.

### Measured after the change (headless Chromium, this runner)

| Viewport | map top before | map top now | map visible |
| --- | --- | --- | --- |
| 1440×900 | 604 | 612 | 288 px |
| 1024×900 | 617 | 625 | 275 px |
| 840×900 | 674 | 682 | 218 px |
| 390×844 | 733 | **722** | 122 px |
| 320×640 | 798 | **767** | 0 (viewport is 640 tall) |

No horizontal overflow at 320/390/600/840/1024/1280/1440 (0 px everywhere). The
map-first harness check (`mapVisible > 200` at 1440 and 840) stays green.

### Verification (this runner, 2026-10-18 ~23:35 UTC)

- `npm run check` ✓ — validation, **94/94** `node --test`, `wrangler deploy
  --dry-run` (30 asset files).
- `node scripts/browser-check.mjs` **72/72** against `wrangler dev` after both
  commits — including map-first (1440: 612/288 · 840: 682/218), the contrast
  sweep, compare, multi-sheet and the device-local list checks. After the
  “Nach oben” control and rebasing over maps-3's `5299f0a`/`e7806e5`/`929e2c2`
  (fullscreen viewer, keyboard sheet strip, degraded-upstream section,
  placeholder scan, phone sheet-strip fix) and maps-2's `c936f0a`/`7a7a87d`/`7c24eca` (point filter, skip list, shared link):
  **90/90** on the integrated tree, `npm test` 101/101. The new check: hidden at
  the top, 48×48 px / 50 % radius / 48 px from the corner when scrolled, click →
  `scrollY 6`, focus `#main`, button hidden again. The rebase conflict in
  `browser-check.mjs`/`docs/run.md` was resolved by keeping both sides' checks
  and facts.
- Token/geometry comparison against upstream commit `552ceb6`
  (`src/assets/css/globals/_variables.scss`, `src/atoms/button/button.scss`,
  `src/atoms/form_input/form_input.scss`): font/spacing/line-height/grid/
  transition/z-index tokens match 1:1 and every hex colour used in
  `public/styles/*.css` is an official palette value. Evidence:
  `docs/design-system.md` → “Verification against the upstream files”.

### Messages

- **→ maps-2**: the Leaflet proposal from last iteration is executed (D5).
  `map.js`, `search.js`, `results.js` and their CSS were not touched; the files
  stay recoverable from history (`git show 64c3f03:public/vendor/leaflet/leaflet.js`).
  If you ever want a library map, say so and I will readd it with a licence file.
- **→ maps-3 (one-line request, not blocking, your file)**:
  `public/styles/detail.css:117` reads
  `line-height: var(--zh-line-medium, 1.45)`; `--zh-line-medium` is **1.3**, so
  the 1.45 is a dead fallback (1.45 is `--zh-line-subbase`, which now exists).
  The `0.8125rem` fallbacks beside `--zh-font-tiny` are 13 px while the token is
  12 px. No visual effect while the tokens exist, so I did not touch your file.
- **→ all**: `main` gate stays `npm run check` + `node scripts/browser-check.mjs`
  (72 checks). `docs/run.md` and `coordination/README.md` are current again.

Iteration 7-12 (2026-10-18 22:5x UTC). Shell/design-system/store/wrangler/docs
owner. Newest entry first; earlier iterations are kept below.

## Iteration 7-12 — the map has to be the first screen, and a Merkliste

| Commit | Content |
| --- | --- |
| `e302956` | **shell: map-first compact intro band + slimmer header.** ≥1024 px the intro is a grid band (headline full width with its cantonal 3 px rule, stock figures beside the lead with the 3 px left rule), the lead is clamped to three lines and the full wording now also stands in “Über das Projekt”, filled from one `data-record-count` hook in `main.js`. Header: one line per bar ≥840 px. Also: `#intro-heading` was missing `zh-heading--1` (the documented 32/40/48 px curve only reached it through the bare `h1` selector, so the app’s 28 px smallest-breakpoint rule was dead code); “Direkt zur Karte” link, Inter preload, og/twitter meta, WebApplication JSON-LD, JSON link to the record set. |
| `dcbd246` | **compare: device-local “Merkliste”.** The pinned list is now also kept in this browser (`kartenzeit.cmp.v1`, record ids only, never sent anywhere). A page load without `?cmp=` restores it with a visible status line; a link with `?cmp=` keeps winning, so shared links stay exact. «Liste leeren» removes it again. Storage calls are wrapped — private mode/disabled storage degrades to “no saved list”. |
| `dcbd246` | **harness: 4 new checks** (see below) plus `tests/compare.test.mjs` (2 new tests) and a narrowed rule in `tests/site.test.mjs` (see the message to maps-3). |

### Measured effect of the shell change (this runner, headless Chromium)

| Viewport | map top before | map top now | map visible on first screen |
| --- | --- | --- | --- |
| 1440×900 | 765 px | **604 px** | 135 px → **296 px** |
| 1024×900 | 745 px | **617 px** | — |
| 390×844 | 937 px | **894 px** | still one thumb-scroll |

Header height 193 → 165 px, intro band 442 → 317 px at 1440. The hero facts
strip, the tags and the h1 all stay; only the clamped lead text is truncated
and it is complete in `#about` now.

### Also landed (same iteration, after the first two commits)

| Commit | Content |
| --- | --- |
| `3d33c70` | **design system: the h4–h6 step is now defined.** Official `src/atoms/headings/headings.scss` gives `h4`, `h5`, `h6` one shared step (`polyFluidSizing` with `$fontSizeCurves/regular` = 16 → 18 → 20 px); `.zh-heading--5` had no rule at all, so the comparison title inherited whatever its element had. `docs/design-system.md` records the derivation and the `.mod-smaller-headings` variant (14/16/18 px, `smallModFontSizeH5H6`) we deliberately do not apply. |
| `331da89` | **licences and crawler policy.** `LICENSE` (MIT for the app source), `NOTICE.md` (per-component table: Inter OFL-1.1, cantonal design system Apache-2.0 as design reference only, swisstopo OGD attribution, e-rara per-record rights, vendored-but-unused Leaflet 1.9.4 BSD-2-Clause), `public/robots.txt`, footer link to NOTICE.md. |
| `cf0728e` | **compact intro band from 840 px** (the cantonal breakpoint where the shell gets its gutters and the two-column header). Tablet map top 830 → 674 px. The harness check now measures 1440 **and** 840 px. |

### Mobile and tablet numbers (this runner, headless Chromium, 80-record seed)

| Viewport | intro band | map top | map visible |
| --- | --- | --- | --- |
| 1440×900 | 317 px | 604 px | 296 px |
| 1024×900 | 331 px | 617 px | 283 px |
| 840×900 | 331 px | 674 px | 226 px |
| 390×844 | 295 px (was 456) | 733 px (was 894) | 111 px (was 0) |
| 320×640 | 316 px | 798 px | 0 px (viewport is 640 px tall) |

### Verification (this runner, 2026-10-18 23:0x UTC)

- `npm run check` ✓ (validation, **90/90** `node --test`, `wrangler deploy
  --dry-run`).
- `node scripts/browser-check.mjs` **68/68** against `wrangler dev` (the count
  grows as teammates add checks), including the five checks I added:
  `the list pinned in this browser comes back without a link`,
  `«Liste leeren» also clears the device-local list`,
  `the map is on the first desktop screen (map-first shell)` (mapVisible 296 px
  at 1440×900) and `the page heading follows the cantonal type curve at 390 px`
  (28 px — the check that would have caught the missing `zh-heading--1`).
- `npm test` 87/87 before and after merging `origin/main` (maps-3 `ecb1342`,
  `9ffcff6`); the merged harness runs green.

## Messages to other members (this iteration)

- **→ maps-3**: I narrowed one rule in **your** `tests/site.test.mjs`. The
  blanket “no `localStorage`” assertion now allows exactly one documented
  exception: `compare.js` may keep the pinned record ids under its versioned key.
  The URL stays the source of truth (a `?cmp=` link always wins over the stored
  list), only ids are stored, and `tests/compare.test.mjs` covers hostile
  values and throwing storage. If you would rather keep the rule absolute, say so
  and I will move the Merkliste behind an explicit “in diesem Browser merken”
  button or drop it — your call, no silent override intended.
- **→ maps-3 (harness)**: I added a section `8f` to `scripts/browser-check.mjs`
  before the console-hygiene block (device-local list restore/clear, map-first
  layout, h1 curve) and merged your `ecb1342`/touch-timeout change without
  conflict. It sets and clears its own device metrics, so it does not disturb
  the surrounding checks.
- **→ maps-0**: the harvest to 80 records landed while I was measuring; all my
  numbers and the harness were re-run against it. No data contract changes from
  me.
- **→ maps-2 (proposal, no action taken)**: `public/vendor/leaflet/` has been
  shipped unused since D2 (192 KiB, no licence file alongside it) — `map.js` is
  its own implementation and the harness never touches Leaflet. I left the files
  alone because D2 was your decision; if you agree, delete the directory and I
  will drop the Leaflet row from `NOTICE.md` in the same pass. Removing it also
  keeps the “no unused vendor payload” story clean for the deliverable.
- **→ maps-2**: the intro band now uses `grid-template-areas` ≥840 px, so
  `.app-intro > .zh-heading--1 / .zh-lead / .zh-facts / .zh-tags` are placed
  explicitly; nothing in `map.js`/`results.js`/`search.js` was touched. The
  mobile map is still first in the grid (`order: -1`), as you set it.

Iteration 4-5 (2026-10-18 21:5x UTC). Shell/design-system/store/docs owner.

## Landed on `main` this iteration

| Commit | Content |
| --- | --- |
| `d55c95a` | `public/_headers` (CSP, nosniff, referrer/frame/permissions policy, cache lifetimes) + honest intro facts strip |
| `8febbcf` | `public/app/compare.js`: comparison list (`cmp` state key, sidebar panel, full-screen side-by-side view with real IIIF/WMTS previews, per-pane original-record links), `tests/compare.test.mjs`, and the `[hidden]` base fix below |
| (earlier) | `f0c954a`: optional-module failures are now visible (`#app-notices` + `document.documentElement.dataset.moduleErrors`) instead of a swallowed `console.warn` |
| (this batch) | compare entry point in the toolbar (`Vergleich öffnen (n)`, visible only with ≥2 pinned records) so the feature is reachable in map-only view too |
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

- ~~`view` (split/map/list) in the URL but no control~~ — done (three chips in the
  toolbar).
- ~~mobile layout audit~~ — done at 390/320 px (see the table above); the map is
  still below the fold at 320×640 because the header alone is 252 px. A further
  step there would have to compact the search header, which belongs to maps-2's
  `search.js` markup.
- `public/vendor/leaflet` (192 KiB, unused since D2): delete it or wire it in;
  see the proposal to maps-2 above. Delete + `NOTICE.md` row removal is a
  5-minute change.
- The 320 px toolbar is 190 px tall (count + compare button, view switch, sort
  select). It could lose its “Ansicht” label visually and share a row with the
  count; not attempted because the result count and the sort control both need
  room at that width.

## Blockers

- None. `GITHUB_TOKEN` from the Actions environment is required for `git push`;
  use a transient credential helper, never a stored secret (`main` pushes are
  working, non-forced, rebased).

---

## Iteration 7-17 (2026-10-19, this runner) — shell/design/store owner

### Recovery first: two commits that never reached `main`

`origin/zurich-maps-1` had two commits from 7-16 (`622c266` phone map-first +
visible Datenstand, `5e3913b` its status notes) that were **not** on `main`, while
the status board already described them. Rebased onto `main` (`78dd3d8`) and
pushed: `6948507`.

- Conflicts: `docs/run.md` (harness row) and `coordination/README.md` (status
  board + gate numbers) — both resolved by *keeping the newer teammate text* and
  splicing in my facts (phone step, 609 px / 235 px at 390×844).
- Verified before pushing: `npm run check` 142/142 tests + `wrangler deploy
  --dry-run`; `node scripts/browser-check.mjs` **131/132** (one failure, see
  below).

### The harness failure was a real store bug, not flake

`✖ one “back” undoes a whole typed search` — one “back” left `?q=Züric` behind.
Diagnosed with a CDP probe that instruments `pushState`/`replaceState` while
typing “Zürich” at the harness' pace (`/tmp/measure-typing.mjs`): the store
pushes only when two keystroke writes are more than `HISTORY_COALESCE_MS`
(900 ms) apart, and a stalled main thread (or a visitor who pauses to read)
produces exactly that. Deterministic reproduction with a 1.2 s pause in the
middle of the word: **2/2 FAIL before, 2/2 PASS after** (`/tmp/stall-typing.mjs`).

Fix (`f10ca3f`, `store.js`): new `HISTORY_TEXT_KEYS = ['q']` — while a `q` change
*continues* the text of the current entry (typing or backspacing, either
direction) it replaces instead of pushing, however long the pause was. A cleared
box, an empty box, or a query rewritten from scratch is still its own step.
`tests/history.test.mjs` covers all of those; the harness typing check now
includes a deliberate 1.2 s stall, so the repo's own suite catches the
regression.

### Shell: honest loading and outage states (`main.js`, `index.html`, `app.css`)

Found by throttling the connection to ~40 kB/s: the results area stayed blank for
seconds while the toolbar claimed “Ergebnisse werden geladen …” (and, with
`/data/records.json` blocked, kept claiming it forever).

- `#results-loading`: visible cantonal state block with the loading-circle
  spinner + what is actually happening, `aria-busy="true"` on `#result-list`;
  `main.js` ends both on success **and** on failure.
- Outage: the panel keeps the plain-German message, the toolbar count becomes
  “Bestand nicht geladen”, and the raw browser string (“Failed to fetch”) moved
  to the console and the `title` attribute instead of the visible text.
- Harness: new check “an unreachable seed says so in plain German and stops
  claiming to load” (blocks `*/data/records.json`, then the existing recovery
  check re-loads). **133/133** checks, 143 unit tests, dry-run green.

### Visual pass (screenshots from the harness + own captures)

- The hero lead was clamped to three lines on a 1440 px screen and ended
  mid-sentence (“… die historischen Kartenwerke…”), which reads like a defect.
  The band now carries one complete sentence; the provenance sentence still
  stands verbatim in “Über das Projekt” and the provider tags sit in the band.
- Checked: map-only view (tiles complete — the harness screenshot is simply
  taken mid-load), comparison view (pane metadata, coupling hint, per-pane
  original links), detail panel (IIIF preview, actions, citation), 320/390 px.
- Measured 768×1024 (tablet): map top 775 px, 249 px of map visible — the hero
  keeps its facts strip there, which is fine.

### Open (for whoever has time)

- 320 px: the header still eats ~500 of 640 px (brand + search + quick picks +
  two-row toolbar), so the map starts below the fold there. Mainstream phone
  widths (360–430) are done.
- The filter panel's histogram/year area is visually empty while the seed loads
  (results.js, maps-2); the shell now says “Bestand wird geladen …” and marks the
  list busy, but the chart itself has no placeholder.
- `results.js` writes `#result-count`; the shell only takes it over in the outage
  case. If maps-2 prefers, the loading text could move into a `records:loaded`
  handler there instead.

### Evidence (this runner, 2026-10-19)

- `npm ci` ✓ · `npm run check` → validation ✓, **143/143** `node --test`,
  `wrangler deploy --dry-run` ✓ (28.76 KiB Worker, `env.ASSETS` only).
- `node scripts/browser-check.mjs` → **133/133** against `npx wrangler dev`.
- Probes (kept out of the repo, in `/tmp`): `measure-typing.mjs`,
  `stall-typing.mjs`, `loading-state.mjs`, `shot-views.mjs`.

### Final verification of this iteration (2026-10-19, this runner)

- Fresh clone of `main` (`/tmp/fresh`): `npm ci` ✓ + `npm run check` → validation ✓,
  **148/148** tests, `wrangler deploy --dry-run` ✓ — the Cloudflare build path
  works from the repository alone.
- Integrated tree after teammates' 169-record seed, cluster change and docs:
  `npm run check` ✓ (**149/149** with the new shell-loading test in
  `tests/site.test.mjs`), `node scripts/browser-check.mjs` → **138/138**.
- `tests/site.test.mjs` (maps-3's file, additive): one offline test keeps the
  loading markup, the spinner, the `aria-busy` flag and both bootstrap paths
  (`finishLoading`, “Bestand nicht geladen”) from drifting apart.
