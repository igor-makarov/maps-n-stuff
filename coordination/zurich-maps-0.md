# zurich-maps-0 status

## Iteration 7-20 (2026-10-19) — the world set becomes a country spread

Commit `bc026cd` (rebased over maps-1's merge `a182b43`; pushed to `main`). The
seed stays **199 records**; what changed is the world set's rule and composition.

### What changed in `scripts/fetch-records.mjs` (set `e-rara:weltuebersichten`)

The world set pooled six continent/world keywords (39 candidates → 21 records).
The same catalogue answers **country keywords**, so six more were added after a
probe of twelve candidates: Deutschland 62 hits, Italien 20, Frankreich 17,
Oesterreich-Ungarn 13, Spanien 7, Grossbritannien 4 (kept), while Niederlande (2
hits, its maps span ~3.5° and cannot pass the 5° area gate), Preussen (12, but its
sheets are also Deutschland hits), Russland (2), Indien/China/Japan (1 each) and
Australien (0) were probed and left out — the numbers live in the set's comment.

Because one keyword answers a third of the pool, the selection is no longer a
plain year sort: `selectSru` gained `quota`/`quotaKey`/`interleave` and the world
set pools its candidates **in rounds over the twelve query groups with a quota of
7 per keyword**, so every keyword contributes its earliest kept sheet before a
productive keyword offers its next one. The 5°-span gate, the outside-canton
window, one-entry-per-title-and-year and the three-per-decade cap are unchanged;
the caps are `candidateCap` 170 / `recordCap` 40.

### Measured this iteration (this runner)

- Warm-cache `npm run harvest`: **2m05s**; console: 187 overview hits (12 queries)
  → 120 candidates → *“SRU kept 21 overview maps outside the canton of 120
  candidates (37 passed the area gate)”*; seed 199 records, 12 comparison layers.
- The kept 21 span **1787–1914** (before 1787–1915) and are held by ETH-Bibliothek
  14, Universitätsbibliothek Bern 6, ZB Zürich 1. Added to the set: the 1795–1805
  “Germania universa” post maps, the 1847 Austrian geological travel overview, the
  1860/1900 “(General-)Karte von Italien”, the 1866/1914 Italian and Franco-German
  war-theatre sheets, the 1875 geological map of Austria-Hungary, the 1902
  Hungarian crown-lands map. Removed: the 1875/1881/1889/1895/1896/1915 Europe
  and Alpine sheets whose decades were full.
- `npm run check` ✓ — validation (199 records, 2 providers, 12 overlays, 27
  depicted periods), **163/163** `node --test`, `wrangler deploy --dry-run`
  (28.76 KiB Worker).
- Integrated-tree CDP harness after rebasing over `a182b43`: **143/143**, no
  console errors, no failed requests (`/tmp/shots-720b/`). The count is 143, not
  the 142 in older notes — a teammate check landed in between; `docs/run.md`
  already states 143, and the board's maps-3 line is refreshed.

### Honest note: the count did not grow

The set keeps 21 records before and after; what changed is the country spread and
that the rule is now documented and reproducible. The pool is the limit: 37
records pass the area gate, and the three-per-decade cap binds because the
candidates cluster in ~7–9 publication decades. A follow-up probe worth doing:
raising the world set's `perDecade` from 3 to 4 (the affected decades would take a
fourth sheet, and the cap 40 has room) — deliberately **not** done in this
iteration because the harvest plus a fresh harness run is the whole budget, and
an unverified data change would have been worse than the modest gain.

### Endpoint evidence for the eleven new records (this iteration)

A bounded checker (record page, thumbnail, IIIF manifest and image-service
`info.json` for each newly added record, concurrency 2, 250 ms politeness pause,
two retries on 429/5xx, 20 s timeout): **44/44 URLs answered 200** — record 11/11,
thumbnail 11/11, manifest 11/11, image service 11/11. So the country sheets are
not only catalogued but actually served by e-rara today. (The full-seed
`npm run verify:endpoints` run stays the earlier 756-URL measurement; this was the
bounded re-check of what changed.)

### Messages

- **→ maps-2:** eleven world records were swapped for country sheets (Italy,
  Austria-Hungary, Germany, France). Nothing inside the canton window changed, so
  the point filter, histogram, footprint and clustering paths keep their data; the
  harness (which exercises them) was run on the rebased tree: **143/143**.
- **→ maps-3:** the harness is **143/143** on the integrated 199-record seed with
  the new world records (`/tmp/shots-720b/`); `docs/run.md`'s 143 is confirmed. One
  new unit-test-relevant fact: none — the world records are plain seed records.
- **→ maps-1:** the README known-limitations sentence is refreshed (world set span
  **1787–1914**, country keywords); no shell/store/style file was touched.
- **→ all:** the seed is unchanged at **199 records / 2 providers**; only the
  world set's composition and its selection rule changed. Any note that says the
  world set is “six queries” is now stale: it is twelve.
- **→ all (data audit):** `e-rara:8602422` and `e-rara:8602432` share title, year
  and extent but are two real items — the coloured (3 Lb 05: 1) and the
  black-and-white (3 Lb 05: 3) issue of Keller's 1800 “Grundriss der Stadt
  Zürich”, with different DOIs, shelfmarks and manifests (checked against both
  IIIF manifests this iteration). The seed keeps both on purpose; they are not a
  dedupe bug.

## Iteration 7-18 (2026-10-19, ~01:15–02:0x UTC) — the Zürich plan set keeps every gate-passing candidate

Commit `d29b649` (rebased over maps-2's `242ccb4`; pushed to `main`). Seed
**140 → 169 records** (142 e-rara + 27 swisstopo); the home view's Zürich window
gains **+29** real plans.

### What changed in `scripts/fetch-records.mjs` (set `e-rara:sru-zurich-plans`)

The two plan queries (`dc.title=Plan and dc.subject=Zürich`,
`dc.title=Karte and dc.subject=Zürich`) answer 92 candidates that state a year and
MODS `<coordinates>`. The set pooled only the 44 oldest (`candidateCap`) and kept
18 (`recordCap`). Now **all 92 are pooled** (`candidateCap` 100) and the cap is 48:
**47 pass the gates**. The 45 dropped candidates are duplicate editions of a title
already kept for the same year, series volumes without a stated `Kartendaten`
extent, or records without a map year — the comment and `records.json.selection`
state that verbatim. The kept 47 span 1754–1920: the 1754 Zürichsee plan, the
1768–1793 militia exercise plans, the 1804/1852/1866/1867/1880 Breitinger plans,
Oberstrass 1869, the 1871 proposals for the Sihl/rail junction, the 1883
Landesausstellung plan, Uetliberg/Käpfnach/Adlisberg, the 1912 Winterthur district
and the 1920 groundwater maps.

### Measured this iteration (this runner, not copied from a commit message)

- Cold `npm run harvest` (no `.cache/fetch/`): **86 s**, wrote all three files;
  console: “SRU kept 47 Zürich plans of 92 candidates … 169 records, 12 comparison
  layers”. A repeat harvest (warm cache) reproduced the same output in 84 s.
- `npm run build` ✓ (169 records, 2 providers, 12 overlays, 27 with a documented
  depicted period); `npm test` **142/142**; `wrangler deploy --dry-run` ✓.
- Measured seed facts the docs now state: institutions ETH-Bibliothek 68,
  Zentralbibliothek Zürich 65, swisstopo 27, Bern 8, Genf 1; corpora `zut` 65,
  `zuz` 61, `bes_1` 8, `gep_r` 1 (135 of 142 e-rara records have a viewer URL);
  142 shelfmarks; 142 manifests; 169 extents; 27 depicted periods; span 1696–2021.
- `npm run verify:endpoints`: **756 distinct URLs** on the 169-record seed. The
  first run reported 21 failures — all e-rara DOI landing pages answering an
  intermittent **500**; three consecutive hand probes of one of them answered
  200, 200, 500, so they are rate/load artefacts, not dead links. The script now
  retries transient `429/5xx/timeout` a bounded number of times
  (`--retries`, default 2, 600 ms · n backoff) and prints how many URLs needed a
  retry. Re-run with `--concurrency 2 --retries 3`: **756/756, 0 failures** —
  record 169/169, thumbnail 169/169, viewer 135/135, manifest 142/142,
  image-service 141/141; 23 URLs answered a transient 5xx once and 200 on the
  retry. `docs/data-sources.md` and `docs/run.md` state that run.
- Integrated-tree harness (`npx wrangler dev` + `node scripts/browser-check.mjs`)
  on the 169-record seed, after rebasing over maps-2's `242ccb4`: **137/137**,
  no console errors, no failed requests (`/tmp/shots-718b/`). The +29 Zürich plans
  did not break the point filter (56 records at Zürich's centre), the footprints,
  the marker clustering, or the seed-derived harness ids.

### Probes that ended in “keep the seed as it is” (documented, nothing shipped)

- **The region (11) and city-plan (10) SRU sets are pool-limited, not cap-limited.**
  Setting their `perDecade` rule from 3 to 9 leaves both counts exactly unchanged
  (probe run), so their caps stay at 16/14 and their rules are untouched.
- **The world set stays at 21 records.** Pooling all 39 candidates and raising the
  per-decade rule from 3 to 9 adds **two** sheets of decades the set already
  covers (21 → 23, 171 records); not worth a rule change and a re-verification.
- **Swiss cities outside Zürich answer too little** for a fifth set. SRU probes
  (2026-10-19): `dc.title=Plan and dc.subject=Basel` 42 hits (mostly books whose
  title contains “plane”; two real Basel plans with year + coordinates),
  `…=Bern` 28 hits (3 usable), `…=Luzern` 3 hits (1 map, no coordinates),
  `…=Genf`/`Genève` 20/31 hits (a handful, most without `<coordinates>`). A set
  would add ~5 records and a misleading title, so it was not implemented; the
  note lives here instead of in the code.
- **The cantonal geoportal is not usable without credentials.**
  `https://wms.zh.ch/OGDZHWMS?SERVICE=WMS&REQUEST=GetCapabilities` → **401
  “HTTP Basic: Access denied.”** on 2026-10-19 (`maps.zh.ch/wms` → 503,
  `webgis.zh.ch` → no answer); GIS-ZH OGD services are token-based, and the swarm
  must not hold or ship such a token. The canton's historical mapwork is already
  covered through swisstopo's `ch.swisstopo.zeitreihen`/`hiks-*` WMTS layers,
  which are the *same* official raster series with OGD terms — no coverage is
  lost.
- **LoC would need invented coordinates.** The Library of Congress JSON API
  (`https://www.loc.gov/maps/?q=…&fo=json`, CORS `*`) and its IIIF manifests are
  documented and rich, but the item JSON states **no** coordinates for the maps
  probed (e.g. `2005625055`, `2013593105`, `2006629175`): a record could not be
  placed on the map without guessing, so no LoC set was added.

### Messages

- **→ maps-1:** `docs/run.md`'s endpoint row and the harness/record counts in
  `README.md` are refreshed to the 169-record seed; the Worker/config/CSP are
  untouched. Nothing in your shell files changed this iteration.
- **→ maps-2:** the seed grew by 29 Zürich-area records (many with city-centre
  extents), so the marker pile around Zürich is denser than when your clustering
  work landed — `242ccb4` rebased cleanly on top of mine and the harness was
  re-run against the integrated tree.
- **→ maps-3:** the harness was run on the 169-record seed: **137/137** (the
  count grew from 131 because your and maps-2's checks landed in between).
  A new record in the seed does **not** add `depictedYear*` (still 27).
- **→ all:** the seed is now **169 records / 10 collections / 2 providers**; any
  copy or check that says 140/119/113 is stale. The Zürich SRU plan set's rule in
  `records.json.selection` is the authoritative statement of what is kept.

## Iteration 7-16 (2026-10-19, ~00:3x–00:5x UTC) — the world view gets real records

Written up late: this iteration timed out before I recorded it. Its commits are
`8055e95` (data) and the seed they produced; nothing else of that session
survived, so the documentation caught up in 7-17 (below).

### A fourth SRU set: “Übersichtskarten von Europa und der Welt” (21 new records)

Every committed record sat inside the Swiss box, so searching or panning outside
Switzerland found nothing. Six more CQL questions the e-rara catalogue answers
became set `e-rara:sru-world-overview`:

```
dc.subject=Europa  and dc.title=Karte   30 hits
dc.title=Erdkarte / dc.title=Weltkarte  (world maps)
dc.subject=Afrika / Amerika / Asien and dc.title=Karte
```

Same gates as the Zürich SRU sets (map genre, stated year, stated MODS
`<coordinates>`, `GetRecord` + IIIF manifest with a stated holding institution and
`Kartendaten` extent, one entry per title and year, ≤ 3 per publication decade)
plus **two mirrored rules**: the centre of the record's own stated extent must lie
**outside** the canton window (the Zürich sets require inside, so the sets stay
disjoint) and the extent must span **≥ 5°** of latitude or longitude — that is
what separates an overview map from a local sheet. 39 candidates with a stated
extent → 21 kept, 1787–1915, held by ZB Zürich, ETH-Bibliothek and
Universitätsbibliothek Bern. A per-query quota was probed and rejected (only the
Europe query answers many extents, so a quota would have shrunk the set without
adding a continent); the rule is stored verbatim in
`records.json.selection['e-rara:sru-world-overview']`.

Seed: 119 → **140 records** (113 e-rara + 27 swisstopo), e-rara span 1696–1919,
seed span 1696–2021.

### Verified on this runner (re-checked in 7-17, not trusted from the commit message)

- `npm run harvest:offline` reproduced all three data files byte for byte
  (the claim in `8055e95`); `npm test` and `npm run check` green.
- `tests/point.test.mjs` was moved from Berlin to a point no record claims
  (Berlin is now covered by a Europe-wide sheet) — the honest-empty assertion had
  to move, it was not weakened.
- **Correction to the commit message:** it says “10 → 11 collection facets”. The
  committed seed has **10 distinct `collection` values** (the world set adds
  `Übersichtskarten von Europa und der Welt`, the universe of sets did not grow by
  two). Verified with `node -e` over `public/data/records.json` and with
  `facets()` in 7-17.

## Iteration 7-17 (2026-10-19, ~00:5x–01:2x UTC) — the numbers the UI shows, the docs now state

Everything below is measured on the integrated tree (`6884bdd` + my commits), not
copied from a previous note.

### 1. Documentation was one harvest behind (119 vs 140 records)

The UI said “140 von 140 Datensätzen”, `docs/run.md`, `README.md`,
`docs/data-sources.md` and the shared board still said 119/92/513. Corrected with
the numbers read out of the committed data:

| Claim | Was | Now (measured) |
| --- | --- | --- |
| seed size | 119 | **140** (113 e-rara + 27 swisstopo) |
| institutions | ZB 51, ETH 35, Bern 5, Genf 1, swisstopo 27 | ZB 53, ETH 51, Bern 8, Genf 1, swisstopo 27 |
| e-rara corpora | `zuz` 51, `zut` 35, `bes_1` 5, `gep_r` 1 | `zuz` 53, `zut` 51, `bes_1` 8, `gep_r` 1 |
| shelfmarks | 92 | **113 of 140** (all e-rara records) |
| `viewerUrl` / `iiifManifest` | 92 | 113 |
| `depictedYearStart` | 27 | 27 of 140 |
| records with a stated extent | 92 (e-rara) | **140** (all records have one) |
| collection facets | 10 | **10** |
| endpoint check | 513/513 (119 records) | **618/618 (140 records)** |

`docs/data-sources.md` also gained the missing section for the world set (queries,
mirrored gates, 39 → 21 candidates, skipped when the gazetteer is down) and a row
in the discovery-window table.

### 2. `npm run verify:endpoints` re-run on the 140-record seed: 618 URLs, 0 failures

Full report `/tmp/endpoints-140.json` (runner-local). Per kind: record 140/140,
thumbnail 140/140, viewer 113/113, manifest 113/113, image-service 112/112. This
replaces the 513-URL figure everywhere it was quoted.

### 3. Integration check of `main` (123 checks, green)

`npm ci && npm run check` → 132 unit tests, `wrangler deploy --dry-run` (30 asset
files, 28.76 KiB Worker, `env.ASSETS` only). `npx wrangler dev` +
`node scripts/browser-check.mjs` → **123/123**, no console errors, no failed
requests, CSP intact (10 same-origin API calls). So the world records did not
break the point filter, the footprints or the harness assertions that were written
against the 119-record seed.

### 4. Small fix in a teammate's file, flagged (mobile facts strip)

`public/styles/app.css` (owner maps-1): at ≤ 400 px the intro facts strip
(`#intro-facts`) was `flex-wrap: nowrap; overflow-x: auto`, so “IIIF-Bildservice
113” was clipped mid-word on a 390 px phone and “Anbieter 2” on a 320 px one, with
no visible scroll affordance. The `@media (max-width: 599px)` block now lays it
out as a two-column grid (`grid-template-columns: repeat(2, minmax(0, 1fr))`; the
`nowrap`/`overflow-x`/`flex: 0 0 auto` declarations are gone, the label/value
sub-layout is unchanged). Measured at 390 px and 320 px: `scrollWidth ==
clientWidth`, all four figures inside the card, two rows, no page overflow — and
the harness stayed at **123/123**.

### 5. Re-verified after the rebase over maps-1's real comparison view (6eef9ba)

`public/app/compare.js`, `detail.js`, `iiif.js`, `app.css`, `detail.css`,
`scripts/browser-check.mjs` and `tests/iiif.test.mjs` all changed while I worked;
my CSS edit is in the ≤ 599 px block and rebased cleanly. On the integrated tree
(`da11385`): `npm run check` → **136 unit tests, 0 failures**,
`wrangler deploy --dry-run` 28.76 KiB; `node scripts/browser-check.mjs` →
**126/126 checks** (maps-1 added three for the coupled comparison panes), no
console errors, no failed requests. So the facts-strip change and the 140-record
seed are fine next to the new comparison view.

### 6. Two probes that ended in “keep the seed as it is” (documented, not shipped)

**Winterthur does not answer a map corpus after the gates.** A fifth SRU set was
implemented and harvested: `dc.title=Karte and dc.subject=Winterthur` (39 hits on
2026-10-19), `dc.title=Plan and dc.subject=Winterthur` (4), `dc.title=Stadtplan`
(1); `dc.title=Ansicht` (1, a façade view) states no extent. 43 hits → 28
candidates that are maps with a stated year and `<coordinates>` → **2 records**
after the manifest/extent gate: `e-rara:28283898` “Karte von Zürich & Adlisberg”
(1897) and `e-rara:30146940` “Geologische Karte der Lägernkette” (1901). Neither
is actually about Winterthur — they are keyword hits — so a set named “Winterthur
und Umgebung” would mislabel them and add two records that the Zürich sets can
already reach. **The set was reverted, not shipped**; the code and the churn are
gone (`fetch-records.mjs` and `public/data/**` are unchanged). If someone wants
Winterthur coverage later, the honest route is the catalogue's Winterthur corpus
pages rather than this keyword.

**Reproducibility of the committed 140-record seed re-proved twice.**
This runner started with no `.cache/fetch/`: a full `npm run harvest` re-fetched
everything (OAI + 7 SRU pages + manifests + WMTS) and wrote `records.json`,
`sources.json` and `overlays.json` that match the committed files **byte for byte
apart from `generatedAt`** (`git diff --stat` = 1 line per file; 140 records, the
same 18/11/10/21 set sizes: “SRU kept 18 Zürich plans of 92 candidates, 11 region,
10 city plans, 21 overview maps of 39 candidates”). So the documented selection
rules, not a lucky cache, are what produced the seed. The warm run then confirmed the offline path too:
`npm run harvest:offline` (no network) rewrote the same three files and
`git diff --stat` showed the same one `generatedAt` line per file — 140 records,
12 comparison layers, the same set sizes. `docs/data-sources.md` now states that
check next to the two commands.

### 7. Final check of this iteration on the integrated `main` (`71f08e6`)

After rebasing over maps-2's histogram brushing (`af0fd26`) and maps-1's 390 px
comparison work (`d6dabc8`): `npm test` **142/142**, `node
scripts/browser-check.mjs` against `npx wrangler dev` **131/131** (the harness is
maps-3's; it grew from 126 to 131 with the two teammates' commits). No console
errors, no failed requests. My two shipped changes of this iteration are the docs
refresh (`f07f488`) and the ≤ 599 px facts strip (`da11385`).

### 8. The published tree builds the way Cloudflare will build it

Fresh `git clone --depth 1 origin/main` into an empty directory (`93f22c8`, which
includes the teammates' commits after mine), then the Cloudflare build sequence
from `docs/run.md`: `npm ci` (lockfile only, 3 s) → `npm run check` → **142/142
tests**, `wrangler deploy --dry-run` reads 30 asset files and a 28.76 KiB Worker
with `env.ASSETS` as the only binding. Nothing in the repository depends on this
runner's `.cache/fetch/` or on uncommitted files, so a Cloudflare build from
`main` has everything it needs (build command `npm run build`, deploy command
`npx wrangler deploy`, no secrets, no bindings beyond static assets).

### Messages

- **→ maps-1:** two small edits in your files, both listed above and in the commit
  messages — `app.css` (facts strip on ≤ 400 px) and the number refresh in
  `README.md`/`docs/run.md`. Revert or reword freely. The shared board row for
  `zurich-maps-0` in `coordination/README.md` is updated with the real counts; the
  “Integration gate as of iteration 7-15 (119-record seed)” line is yours and still
  says 119 — please refresh it when you next integrate.
- **→ maps-2:** the world records are the first ones whose extents are *big* (whole
  continents, ≥ 5° span) next to the city sheets; the footprints layer and the
  clustering both coped in the harness run. A search for “Europa”/“Erdkarte” now
  returns real rows.
- **→ maps-3:** `scripts/browser-check.mjs` reported 123/123 on the 140-record
  seed without a change; the counts in `docs/run.md`’s row for the harness (123)
  are current.
- **→ all:** the seed is **140 records / 10 collections**; any copy or check that
  hardcodes 119/98/109/80/90 is stale.

### Next (my area)

1. The Winterthur `dc.title=Karte` keyword hits (39) still collect no records; the
   canton window admits Winterthur.
2. `records.json` still has no `depictedYear*` for the 1919 “Stadtplan von
   Winterthur vom Jahre 1755” (title names the depicted year, catalogue says 1919)
   — a title-anchored rule would fill exactly one record, so it stays noted.
3. A cold `npm run harvest` was not possible in this runner’s budget (no
   `.cache/fetch/` in a fresh clone); the next iteration should run
   `npm run harvest` once and confirm `harvest:offline` reproduces the committed
   bytes with the world set included.

## Iteration 7-15 (2026-10-19, ~00:0x–00:4x UTC) — Zürich and its surroundings, 109 records

Same paths (`scripts/fetch-records.mjs`, `scripts/verify-endpoints.mjs`, `public/data/**`,
`public/app/records.js`, `tests/records.test.mjs`, `docs/**`, `README.md`) plus three
small additive edits in teammates' files (index.html label, package.json script,
docs/run.md row — all flagged under Messages).

### 1. A second SRU set: “Zürich und Umgebung (Kanton, Stadt und See)” (11 new records)

The 7-14 SRU set only asked two questions (`dc.title=Plan/Karte and dc.subject=Zürich`)
and so stopped at 1871 (its 18 records keep the oldest years first). Three more
CQL questions that the catalogue answers are now asked, with the same gates and the
same canton-window (nothing about the gates was loosened):

```
dc.title=Umgebung  and dc.subject=Zürich   45 hits
dc.subject=Zürichsee                       25 hits
dc.title=Stadtplan and dc.subject=Zürich    2 hits
```

`dc.title=Ansicht` (43 hits) and `dc.title=Vogelschau` (2 hits) were probed too and
are **not** queried: neither yields a map record with a stated extent.

- **The window cap was the real problem, not the queries.** Candidates sorted by year
  cluster in a few decades, so “oldest first, keep 16” dropped the whole 20th century
  of the new set again. The region set now keeps **at most three records per
  publication decade**, which is still deterministic and hand-picking-free. Result:
  `considered` 24 candidates with a stated extent → 11 kept, spanning 1766–1919
  (1766 “Prospectus … lacus Tigurini” and 1780 “Le lac de Zürich avec ses environs”,
  Universitätsbibliothek Bern; the 1875/1876/1879/1881 Übersichtspläne; the 1896
  Kümmerly Zürichsee map; the 1908 Zürichsee basin + Turbenthal sheets; the 1919
  Randmoränen and the 1919 Winterthur city plan). The e-rara part of the seed now
  spans **1754–1919** (was 1754–1871) and the whole seed 1754–2021.
- The canton window still does its job on the new queries: the 1840 “Rigi-Berg und
  seine Umgebungen”, “Stadtplan von Riga”, the Baden/Luzern/Lugano surroundings are
  all keyword hits outside the canton and are filtered out by the centre-of-extent
  rule. Nothing is hand-picked: `records.json.selection['e-rara:sru-zurich-region']`
  states the queries, the cap and the per-decade rule.
- Title/year dedupe is shared with the plans set, so a sheet both searches find is
  kept once (e.g. the 1871 “Plan von Zürich und Umgebung” in both `zut` and `zuz`).

**Follow-up (same iteration, second harvest): a third SRU set for the city plans.**
Two more catalogue questions — `dc.title=Grundriss and dc.subject=Zürich` (32 hits)
and `dc.title=Situationsplan and dc.subject=Zürich` (16 hits) — answer the city's own
ground and site plans, so they became their own set “Grundrisse und
Situationspläne der Stadt Zürich” (cap 14, ≤ 3/decade): **10 records, 1696–1890** —
the 1696 and 1705 fortress ground plans, the 1800 “Grundriss der Stadt Zürich und
der umliegenden Gegend” (ZB plus the copy bound in a Bern `Helvetia` volume), the
1826 Schwamendingen forest plan, the 1838 city plan, the 1847 Altstetten site plan
and the 1881 exhibition/quay and 1890 tramway Situationspläne. Off-topic keyword
hits of `Grundriss` (Murten lake, Bischofszell, a cantonal hospital farm) are removed
by the same canton window and extent gates. Why a third set instead of more queries
in the region set: a 1705 fortress plan and a 1838 city plan are the same kind of
one-sheet object and inside one set would displace each other's decade under the
3-per-decade rule.

**The duplicate tie-break is now documented.** The catalogue lists many sheets in
both `zuz` (ZB Zürich) and `zut` (ETH), so the survivor used to be “whichever the
search returned first”. Candidates are now ordered by year → `zuz` first → catalogue
id, which is why nine records of the seed changed corpus (e.g. the 1:25 000 canton
map is now the ZB copy with **35 sheets** instead of ETH's 33, and the 1852/1858/
1867 plans are ZB copies). Same titles and years, same upstream metadata, but the
cantonal library — the design reference's own — holds them now. Copies whose
*catalogued titles differ* (the Bern volume copies) stay as separate records: they
are separate upstream items with their own shelfmark and DOI.

Seed after both harvests: **119 records** = 92 e-rara (ZB 51, ETH 35, UB Bern 5,
Genève 1) + 27 swisstopo overlays, 10 collection facets, e-rara span **1696–1919**.

### 2. Holding library is never defaulted any more (latent honesty bug)

`manifestRecord` used to fall back to `candidate.zuz ? 'Zentralbibliothek Zürich' :
'ETH-Bibliothek Zürich'` when a manifest states no `Besitzende Institution`. For any
corpus other than `zuz`/`zut` (`bes_1` Bern, `gep_r` Genève, …) that would have
attributed the map to **ETH-Bibliothek Zürich** — a wrong credit. The fallback is now
the corpus the catalogue itself states (`<vl:prefix>` of an SRU hit, the OAI
`setSpec`, or the `og:url` of the DOI landing page, which also verifies the id), with
`zuz`→ZB, `zut`→ETH, `bes_1`→UB Bern, `gep_r`→Bibliothèque de Genève; when neither
the manifest nor a known corpus names a library the record is dropped and the drop is
written into `records.json.skipped` (alongside the empty-tile Zeitreise edition) —
no library is ever guessed. In this run the new path was never needed (every manifest
states the field, all 4 Bern records are credited to Universitätsbibliothek Bern, all
44 `zut` records to ETH-Bibliothek, 33 `zuz` to ZB, 1 `gep_r` to Genève, 27 swisstopo),
which is exactly why the check is a drop instead of a default: it must not silently
wrong a credit the day an upstream omits the field.

### Numbers after this change (committed seed)

119 records = 92 e-rara (26 ZB Wildkarte sheets, 26 `landkarten`, 18 plans, 11 region,
10 city plans, 1 Genf) + 27 swisstopo overlay editions; 10 collection facets;
92 shelfmarks; 92 viewer URLs; 27 with a documented depicted period; publication
years 1696–2021 (e-rara 1696–1919).

### Verified on this runner

- `node scripts/fetch-records.mjs --out public/data` — two refreshes this iteration
  (67 s and 76 s warm, most responses already cached), ~300 upstream requests.
- `npm run harvest:offline` **reproduces every committed byte** of `records.json`,
  `sources.json`, `overlays.json` (all three MATCH after dropping `generatedAt`),
  so the new queries and the institution rule replay without network access.
- `npm run check` ✓ at every step. Final integrated tree (after rebasing over
  maps-1's back/forward store work `7fa8c07`, maps-2's “Karten zum Stichwort” +
  footprint layer and maps-3's shareable cut-out `vv=`): **127/127** unit tests and
  `wrangler deploy --dry-run` (30 asset files, 28.76 KiB Worker, `env.ASSETS` only).
- `node scripts/browser-check.mjs` against `npx wrangler dev` → **109/109** on that
  integrated tree with the 119-record seed; no console errors, no failed requests,
  and the collection facet now offers 10 real series.
- Every new record re-probed upstream: `recordUrl` (DOI), `viewerUrl`, `thumbnail`
  and `iiifManifest` all 200 for the sampled records, PDM 1.0 matches the upstream
  `dc:rights`, and each manifest's `Kartendaten` bbox is the record's `extent`.

### Messages

- **→ all**: the seed is `119` records (10 collection facets); the UI count is
  data-driven, but any copy, screenshot or check that hardcodes 98/109/80/90 numbers
  needs the new value.
- **→ maps-1**: two small additive edits in your files, both flagged here —
  `public/index.html` (the keyword label now reads “Stichwort in Titel, Urheber
  oder Sammlung”, placeholder “z. B. Rhein, Wildkarte, Dufour”), and `package.json`
  + `docs/run.md` (`npm run verify:endpoints`). Revert/reword freely; nothing else
  in the shell, tokens or wrangler config was touched.
- **→ maps-2**: the new region records are small city extents and one canton-wide
  sheet (1896 Zürichsee, 1919 Randmoränen), so the clustering you added is what keeps
  the default view readable; the new collection appears in the facet automatically.
- **→ maps-3**: the new records include 3-sheet works (1780 “Le lac de Zürich”, 1804
  “Plan de la ville et des environs de Zürich”, 1896 Kümmerly) and 2-sheet ones (1908,
  1919) — the strip keeps working (95/95 run). The extreme case is now the **35-sheet**
  ZB copy of the 1:25 000 canton map (was 33 sheets, ETH copy).
- **→ maps-1**: `public/data/**` counts changed only; no shell/token/wrangler change
  was needed. `docs/data-sources.md` + `README.md` updated by me.

### Follow-up in the same iteration

**1. The keyword box now answers the words the app itself shows.** `matchesQuery`
searched title/creators/institution/shelfmark/publisher only, so a visitor who read
“Karte des Kantons Zürich 1:25 000 (Wildkarte)” in the collection facet or
“4 Lb 06: 9” in a citation typed those words and got **0 results**. `records.js`
(`titleText`) now also covers `collection` and `imprint` — text the dataset itself
states, nothing derived. Checked in the running app: `?q=Wildkarte` → **26/109**
rows (exactly the 26 sheets), `?q=Pläne aus Zürich` → 18,
`?q=Universitätsbibliothek Bern` → 4 (the new Bern records), `?q=Siegfriedkarte` →
4 in the default range / 9 over 1500–2021, `?q=zusammenfassung` → the honest empty
state. Two new tests in `tests/records.test.mjs` (103 total) pin the new words and
the invariant that **every collection name in the committed seed is findable by its
own keywords**, so a facet rename cannot silently break search.

**2. `npm run verify:endpoints` — the online counterpart of the offline gate.**
`npm test` runs offline on purpose, so a dead upstream link could survive a refresh
unnoticed. `scripts/verify-endpoints.mjs` now collects every distinct URL the data
promises (record, viewer, thumbnail, IIIF manifest, first-canvas image service,
WMTS preview), probes each once at 4 concurrent requests with a descriptive
User-Agent, summarises per kind and exits non-zero on any non-200 (`--json`,
`--offline`, `--limit` supported). Deliberately **not** part of `npm run check`, so
the gate stays hermetic and fast.

Result on the committed **119-record** seed (2026-10-19, re-run after the third SRU
set): **513 distinct URLs, 0 failures** — record 119/119, thumbnail 119/119, viewer
92/92, manifest 92/92, image-service 91/91.

The rebase kept both sides: maps-2's “Karten zum Stichwort …” chip feeds the same
keyword filter my change widened, so a place name now also reaches records whose
collection or imprint names it (the chip and the box share `matchesQuery`). That re-proves the older records' links too, not only the new
ones, and replaces the ad-hoc 266-URL probe of 7-14 with a committed script.

**3. Cantonal raster services are not openly usable (negative result, recorded).**
I probed the canton's own route for a possible *cantonal* historical-map overlay:
`maps.zh.ch` (the GIS-Browser) is a JavaScript app with no service links in its
HTML, `geo.zh.ch` likewise, `data.zh.ch` is an ordinary zh.ch content page, and the
WMS paths GIS-ZH products usually expose (`wms.zh.ch/OGDZHWMS`,
`maps.zh.ch/wms/OGDZHWMS`) answer **401 Basic auth**. A credential is neither
available nor appropriate here, so the overlays stay with swisstopo's documented
Open Government Data geoservices (WMTS + SearchServer), which `sources.json` cites.
Recorded so the next iteration does not repeat the probe.

### Next (my area)

1. More SRU vocabulary is still cheap (`dc.title=Situationsplan`, `dc.title=Grundriss`,
   `dc.title=Plan and dc.subject=Winterthur`) — each new query must keep the canton
   window gate and the per-decade spread.
2. Winterthur has 39 `dc.title=Karte` keyword hits that no query collects yet — the
   canton window admits them (Winterthur is in the canton), so a fourth set is the
   natural next step if more cantonal coverage is wanted.
3. The 1919 “Stadtplan von Winterthur vom Jahre 1755” is a reproduction: the
   catalogue states `dc:date` 1919 **and** 1755, and the title names the depicted year.
   A title-anchored “vom Jahre YYYY” rule would fill `depictedYear*` for exactly one
   record today, so it was not worth a parser; noted instead of guessed.
4. Library of Congress stays a list-only idea (no coordinates in its JSON API).

## Iteration 7-14 (2026-10-18, ~23:2x–24:1x UTC) — SRU discovery, 98 records, shelfmarks

Same paths as before (`scripts/fetch-records.mjs`, `public/data/**`, `src/worker/**`,
`public/app/records.js`, `docs/data-sources.md`) plus two small edits in files I do
not own (noted below).

### 1. Zürich plans via the catalogue's own SRU service (18 new records, 80 → 98)

Paging the `zuz` OAI set deeper is a dead end: pages 32–50 (≈200 records) yield
**three** map candidates, all the same 16th-century atlas — the set is unsorted
*ingest* order, so single sheets and city plans are simply not reachable by paging.
**Action: e-rara publishes a standard SRU 1.2 endpoint** (`https://www.e-rara.ch/sru`,
MODS records) whose CQL indexes `dc.title`, `dc.subject` (keyword) and `dc.creator`
map to the catalogue search; every other index (`dc.type`, `dc.genre`, `dc.format`,
`dc.coverage`) answers 0 records. Two documented queries:

```
dc.title=Plan  and dc.subject=Zürich     104 hits
dc.title=Karte and dc.subject=Zürich      63 hits
```

Each MODS hit states the IIIF title id and corpus verbatim (`<vl:id>`, `<vl:prefix>`)
and a `<coordinates>` statement, so **discovery is cheap**; nothing is trusted from
the search response alone: the candidate is confirmed with
`oai?verb=GetRecord&identifier=oai:www.e-rara.ch:<titleId>` (gives `dc:rights`,
DOI, map type, year) and then built from its IIIF manifest like every other record.

- **Geo gate (the interesting failure).** My first run kept 18 records but 4 of them
  were off-topic: “Germania universa: 7. Plan sur la situation du camp” (a camp near
  Wertheim, 49.95–50.07 N) and “Helvetia universa: 28. Karte von der Schweiz” — the
  keyword “Zürich” matched inside multi-work volumes. Fix: the **centre of the
  record's own stated extent must lie inside the canton of Zürich's bounding box**,
  and that box is read at harvest time from swisstopo's gazetteer
  (`SearchServer?type=locations&origins=kantone`, the GG25 canton layer):
  `8.35184–8.995768 E / 47.1557–47.697043 N`. It is stored in
  `records.json.selection['e-rara:sru-zurich-plans'].cantonWindow`; if the gazetteer
  cannot be reached the whole set is skipped instead of shipping it ungated.
- Result: **18 records** from ZB Zürich (7) and ETH-Bibliothek (9) plus two Bern
  `Helvetia` sheets whose stated extent covers Zürich — “Plan der Stadt Zürich nach
  Breitinger” 1852/1866/1867, the 1852/1858/1860 canton maps, “Plan des Zürich-Sees”
  1754, the 1768–1793 military exercise plans, Oberstrass 1869 and the 1871
  “Geologischer Plan von Zürich und Umgebung”. The seed now spans **1754–2021**
  (was 1781–2021).

### 2. Shelfmarks are no longer dropped (71 of 98 records)

The manifest states `Besitzende Institution = Zentralbibliothek Zürich, 4 Lb 06: 9`;
the old code kept only the part before the comma, so the detail view showed
“Signatur: nicht angegeben” for every e-rara record. The part after the comma is now
stored as `shelfmark` (verbatim) — 71 of 98 records have one.

### 3. Two small edits outside my paths (please review)

- `scripts/browser-check.mjs` (maps-3): the check “detail names the holding
  institution and rights” hardcoded `/Zentralbibliothek|ETH-Bibliothek|swisstopo/`,
  so it went red on a real record from the **Universitätsbibliothek Bern** (and it
  searched only the first 400 characters of the panel). It now reads the expected
  institution from the selected row's `data-record-id` → `records.json` and searches
  the whole panel text. Behaviour for the old records is unchanged; the assertion is
  stricter (it must name *that* record's institution).
- `docs/data-sources.md`, `README.md`: counts, the SRU method, the geo gate, the
  shelfmark field, the new corpora (`zut` 35, `zuz` 33, `bes_1` 2, `gep_r` 1).

### Verified

- `npm run build` ✓ — 98 records, 2 providers, 12 overlays, **27** with a documented
depicted period (the 1852 canton map states the same survey phrase as the Wildkarte
sheets).
- `npm test` ✓ **101/101** on the tree rebased onto teammates' `a340f3d`/`7a7a87d`;
  `npm run check` also runs `wrangler deploy --dry-run` (28.76 KiB Worker,
  `env.ASSETS` only) ✓.
- `node scripts/browser-check.mjs` against a fresh `wrangler dev` (98 records) →
**89/89**, including maps-1's new degraded-upstream section and maps-2's point
  filter, so the seed change did not disturb their checks. The only red in the first
  run was the hardcoded institution list (fixed above).
- Every record endpoint re-probed (266 URLs): thumbnails 80/80, manifests 53/53,
  record pages 80/80, viewer pages 53/53 → **0 non-200** on the 80-record tree; the
  new records’ thumbnails, manifests, DOIs and viewer URLs are verified by the
  harvest itself, which only keeps a record whose manifest states a thumbnail, and
  by the harness, which loads three of the new records' images.

### Messages

- **→ maps-3**: the seed now contains `e-rara:7325578` — a **33-sheet** digitised
  “Karte des Kantons Zürich im Masstab von 1:25 000” (1852). Your sheet strip was
  designed for 2–3 sheets; the multi-sheet harness check still picks the 1799
  2-sheet record, so nothing is red, but a real user opening that record gets 33
  strip thumbnails. This is the case your “virtualise or collapse after the first N”
  note describes. Also: I changed one line of your harness check (above).
- **→ maps-2**: no map/results changes needed; the new records carry the same
  `extent`/`geo`/`collection` shape, and the new collection “Pläne aus Zürich
  (Stadt und Umgebung)” appears in the facet automatically. The new Zürich plans are
  small extents (city-plan size), so the marker clustering you added is what keeps
  the default Zürich view readable.
- **→ maps-1**: README/docs counts updated to 98 records, 71 e-rara / 27 swisstopo.
  Nothing in the shell or the design tokens changed.
- **→ all**: `npm run harvest` now makes ~3 extra SRU requests and one gazetteer
  request; `npm run harvest:offline` still reproduces the committed data from the
  cache (the SRU pages, GetRecord responses and the canton window are cached too).

### Next (my area)

1. Backfill `shelfmark` for the 27 swisstopo overlays? No: swisstopo states no
   signature — leave them. For e-rara the value is complete.
2. More SRU queries are cheap now that the pipeline exists (`dc.title=Ansicht`,
   `dc.title=Umgebung`, `dc.subject=Zürichsee`) — but each new query must keep the
   canton window gate, and the 18-record cap is what keeps the map readable.
3. The Library of Congress idea stays open: its JSON API states no coordinates for
   the items checked, so it would be list-only (maps-3's viewer already accepts a
   service-only canvas). Not started.

## Iteration 7-13 (2026-10-18, ~23:3x UTC) — wider harvest, 80 records

Landed on `main` as `1b8d849` (rebased over `ec2307e` first). Only my own paths
changed: `scripts/fetch-records.mjs`, `public/data/{records,sources,overlays}.json`.

### What changed

The ZB OAI set (`zuz`) turns out to hold **54,999 records** — it is the whole ZB
corpus, not a map set — so 22 pages yielded only 41 map candidates, 20 of which
survived the sheet cap. Deeper paging plus wider candidate windows:

| Set | pages | window | kept |
| --- | --- | --- | --- |
| `zuz` (ZB Zürich) | 22 → 32 | 48 → 72 | 20 → **26** Wildkarte sheets |
| `landkarten` (ETH-Bibliothek) | 10 → 12 | 30 → 50 | 18 → **26** |
| `cartesgeneve` | 4 → 6 | 14 → **40** | 1 (unchanged, but no longer accidental) |
| `museecarto` | — → 6 | — → 20 | **0** (documented below) |

- **Genf regression caught before it shipped.** The first run of the wider window
  dropped the 1837 “Geneva” sheet (Bibliothèque de Genève), because a 14-candidate
  slice sorted by year loses 19th-century sheets behind older ones. `cartesgeneve`
  is now sliced at 40 candidates with the reason written into the script, and the
  record is back. This is exactly the kind of silent loss a re-harvest can cause;
  the number is now data-driven instead of hand-tuned.
- **`museecarto` is probed and reported honestly**: 53 map candidates, **0 kept**,
  because no manifest of that set states a `Kartendaten` extent, and its works come
  from several libraries — so `manifestRecord` only accepts one when the manifest
  itself names the holding institution (`requireInstitution`). No institution is
  ever guessed. `records.json.selection['e-rara:museecarto']` records this.
- `sources.json` OAI description now lists all four sets; the swisstopo/overlay
  data is unchanged (12 layers, same editions).

Result: **80 records** — 26 ZB Zürich Wildkarte sheets, 26 Swiss maps from the
ETH-Bibliothek set, 1 Geneva sheet, 27 swisstopo overlay editions. 2 providers, 5
collections, still every record with an upstream year and a stated bbox.

### Verified

- `npm run build` (`scripts/validate.mjs`) ✓ — 80 records, 2 providers, 12 overlays.
- `npm test` ✓ **83/83** (the suite is data-driven; nothing hardcoded the old count).
- `wrangler dev` on 127.0.0.1:8787 + `node scripts/browser-check.mjs` → **54/56**.
  Green: module boot (“80 Datensätze · 12 Kartenwerke”), place search, keyboard
  map/selection, shared URL state, the detail→time hand-off, mobile + 320 px
  layouts, contrast sweep (1264 elements), collection link, comparison list and
  view, multi-sheet navigation, no console errors, no failed requests,
  same-origin-only traffic.
- **The first run was 54/56, the second 56/56.** The two red checks were the two
  touch checks in the IIIF viewer (“pinch-zoom asks for a smaller IIIF region”,
  “one-finger drag pans the sheet”): both reported
  `full/490,… -> full/490,… state=loading` while the pointer events *were*
  delivered (`down/move/up 2/12/2`).

  Diagnosed instead of re-run blindly, because the record under test changed with
  this harvest (`e-rara:7203623`, the first row of the default period): I wrote a
  focused CDP repro (`/tmp/touch-repro.mjs`, both the `?sel=` deep-link path and
  the real “scroll the first result into view, click it, then pinch/drag” path)
  and dumped the network requests, the viewer state and the readout. In every
  controlled run the gestures work — pinch →
  `7203623/6497,9259,5223,4718/710,/0/default.jpg` (state `ready`, 710×641 px),
  drag → `7527,9921,5223,4718/710,…` — and a direct `curl` of both regions
  answers **200 in ~1 s**. The 56/56 re-run confirms it: the failure was
  **upstream load**, not a product bug. The first harness run started ~60 s after
  the harvest had pulled ~350 responses from `www.e-rara.ch`; the three of us
  share that origin, so a check that waits 25 s for a fresh region can go red
  while e-rara is still busy.

  **→ maps-3**: no fix needed from my side, but the touch checks are the only
  ones that wait on a *provider-generated* image, so they are the ones that
  flake after a harvest. A single retry of the gesture (or a note that the run is
  unreliable right after `npm run harvest`) would make the harness report honest
  reds. I kept my repro out of the repo on purpose — it is a diagnostic, not a
  check.

### Follow-up commit `a8caa5c` (same iteration)

- `sources.json` derives the e-rara `institutions` list from the harvested
  records (it gained “Bibliothèque de Genève” with the recovered Geneva sheet)
  instead of two hardcoded names — the registry can no longer drift from the
  data.
- the probed `museecarto` set is registered with an honest `note` (53 candidates,
  0 records, why).
- `docs/data-sources.md` gained the discovery-window table (pages read, candidate
  window, kept per set) and the Geneva count-slicing trap; the README
  known-limitations count is corrected to 80 records.
- Reproducibility checked explicitly: `npm run harvest:offline` replays the cache
  and rebuilds the **same 80 record ids** (`same record ids: true`).

### Commit `def42db` — documented depicted periods (survey dates)

The detail panel showed “Dargestellter Zeitraum: vom Anbieter nicht angegeben” for
every e-rara record. The manifests do state it for the Zürich Wildkarte series
(“… nach den in den Jahren 1843-1851 gemachten Aufnahmen von 1852-1865 in Stein
gravirt”), so the harvest now fills `depictedYearStart/End` **and** the verbatim
match in `depictedSource` for **26 of 80 records** (all Wildkarte sheets, printed
1853).

- Only the anchored survey phrase is accepted. The loose reading
  “Aufnahmen von XXXX-YYYY” would have written the *engraving* years (1852–1865)
  into the data — 35 cached manifests contain that wording. Rules: range must not
  postdate the imprint, only whole pairs, evidence always stored.
- `scripts/validate.mjs` (the build gate) enforces exactly those invariants, so a
  future harvest cannot quietly drop the evidence.
- **One line changed in maps-3's `detail.js`**: “Zeitraum dieses Blattes filtern”
  preferred the depicted period, which contradicts its own doc comment, the
  slider label “Zeitraum (Publikationsjahr)” and the harness check that reads the
  panel's `Publikationsjahr`; with the new data it would have filtered 1843–1851
  and hidden the very sheet (1853). It now uses the publication range. If you
  prefer a depicted-period filter instead, it needs the slider semantics to say
  so — say the word and it is a two-file change.

### Diagnostic that cost me time — stale headless Chromium

Two harness runs in this iteration (54/56, and a probe that claimed the new data
was missing) were **polluted by leftover `chromium --headless` processes from
earlier runs**: they keep `--remote-debugging-port=9222/9333` and their own HTTP
cache, so a new run silently connects to the *old* browser and reads a
pre-harvest `/data/records.json` (`Cache-Control: max-age=600`). Symptom: the app
“ignores” a fresh data file while `curl` shows it. Fix: kill leftovers before a
run (`pkill -9 -f 'remote-debugging-port=9222'` in a *script*, not on a command
line that contains the pattern) or use a unique debug port. After a clean start:
**61/61**.

**→ all**: `wrangler dev` also serves a *snapshot* of `public/` taken at startup, so
`/data/records.json` stays old after a re-harvest until the dev server is
restarted (`/api/*` reads from disk, which makes the difference look like an app
bug). Restart the preview after `npm run harvest`.

### Next (my area)

1. (done) The touch failures were upstream load, not a pointer bug — see above.
2. Keep growing Zürich depth from the same OAI set (`zuz` is 54,999 records; the
   harvest still only reads 320 of them) — but only with the stated-bbox and
   stated-institution gates; consider paging by `from`/`until` to sample more
   systematically instead of reading the first N pages.
3. The `overlays.json` swisstopo part did not change this iteration; the LOC
   world-coverage idea from last iteration is still open (its JSON API has no
   coordinates for the items checked, so it would be list-only — an honest taste
   decision, not a data question).

## Iteration 6-12 (2026-10-18, 22:31–23:2x UTC) — data layer + integration fixes

Owner of the same paths as before (`src/worker/**`, `public/data/**`,
`public/app/records.js`, `scripts/fetch-*`, `docs/data-sources.md`). All work was
rebased onto teammates' commits before each push (main moved 6× during the
iteration; nothing of theirs was reverted).

### 1. The shared harness was red on `main` — fixed (`b1f029f`)

First baseline run of this iteration: **40/41** — `detail offers an honest
citation and reuse links` failed (0 links). Root cause: `#reuse-links` was filled
only from the parsed IIIF manifest, but the check ran immediately after opening
the panel, i.e. while the manifest request was still in flight.

- `detail.js`: render the full-size IIIF link from the harvested
  `record.imageService` on first paint and fall back to it in `updateReuseLinks`
  (the link no longer depends on a network round-trip).
- `scripts/browser-check.mjs`: bounded (20 s) wait for that link before asserting.

maps-3's `3ac1232` ("honest reuse fallback") landed in the same area while I was
pushing; the two are complementary (mine = harvested service, theirs = manifest
failure path) and both are on `main`.

### 2. Data: canonical viewer URLs, canvas counts, wider selection (`65e6cf5`)

Answers maps-3's request and grows the seed **55 → 66 records**:

- `viewerUrl` for **all 39** e-rara records — the DOI landing page states the
  holding corpus in `og:url` (`http://www.e-rara.ch/<corpus>/<id>`); the harvest
  keeps the corpus only after verifying `<id>` against the manifest title id and
  stores `https://www.e-rara.ch/<corpus>/content/zoom/<id>`. Corpora: `zuz` 20,
  `zut` 18, `gep_r` 1. `iiif.js` already prefers it, so the panel no longer needs
  the manifest for the viewer link.
- `canvasCount` for 38 records; **four are real multi-sheet works (2–3 sheets)**,
  so the sheet-navigation code path now has real data (maps-3's open item).
- Selection instead of a hand-written 14-title allowlist: every non-series map of
  the OAI set, oldest first — `landkarten` 18 (was 12), ZB Wildkarte 20 sheets
  (was 16), new `cartesgeneve` set 1 (Bibliothèque de Genève). Records still
  require a stated `Kartendaten` bbox and an upstream year; per-set numbers and
  rules are written into `records.json.selection`.
- `sources.json`: the new set is registered; collection entries point at an
  actually harvested record, not a guessed collection page.
- Reproduction: `npm run harvest` (~50 s warm, cached under `.cache/fetch/`),
  `npm run harvest:offline` replays the cache.

### 3. Harness expectations that the wider seed invalidated (`da61055`)

Two checks hardcoded `1816`, the earliest year of the old seed; the app was
correct (the time slider is bounded by the data, so the default period now starts
at 1788). Fixed by reading the live controls: the detail→filter hand-off check
reads `Publikationsjahr` from the panel, the collection-facet hint check compares
against the current slider range. Also `43/44` → **44/44** after maps-2's
`f4a4380` stabilised the touch checks.

### Verified (this runner, `wrangler dev` on 127.0.0.1:8787)

- `npm run check` ✓ — validation, **78/78** `node --test`, `wrangler deploy
  --dry-run` (28.76 KiB Worker, `env.ASSETS` only).
- `node scripts/browser-check.mjs` → **44/44**: 66 records, 20 rows in the
  default 1788–1900 period, Zeitreise/Siegfried/SWISSIMAGE tiles, place search,
  keyboard selection, deep zoom + touch gestures, collection deep link,
  comparison list, contrast sweep, no console errors, no failed requests.
- Data spot checks: `pdf`-free real IIIF images decode; the Geneve record is
  `Bibliothèque de Genève`, 1837, with a stated bbox; every record has an extent.

### Messages

- **→ maps-2**: the seed is now 66 records / 7 collections; your facet counts and
  the histogram scale with the data (nothing in my layer assumed a count). The
  `landkarten` group is now a rule-based selection, so titles inside
  “Schweizer Landkarten aus vier Jahrhunderten” changed — if your histogram bins
  are asserted against fixture titles, check them.
- **→ maps-3**: `viewerUrl` + `canvasCount` are in the data (request done). The
  four multi-sheet records give the sheet navigation real fixtures; if you show
  “N Blätter” before the manifest arrives, `record.canvasCount` is there for it.
  Your `3ac1232` reuse fallback and my `b1f029f` both live in the same function —
  keep whichever you prefer, they do not fight (mine only fills the link earlier).
- **→ maps-1**: no shell/CSS changes from me. `sources.json` now has 4 registered
  collections for e-rara (2 unchanged, 2 new) plus the swisstopo ones; if the
  intro counts collections, it can use `facets(records).collections` (7 series).
- **→ all**: `npm run harvest` is safe to re-run; `.cache/fetch/` is git-ignored,
  so a runner without the cache downloads the same ~120 bounded upstream
  responses (≈50 s).

### Commit `def42db` — documented depicted periods (survey dates)

The detail panel showed “Dargestellter Zeitraum: vom Anbieter nicht angegeben” for
every e-rara record. The manifests do state it for the Zürich Wildkarte series
(“… nach den in den Jahren 1843-1851 gemachten Aufnahmen von 1852-1865 in Stein
gravirt”), so the harvest now fills `depictedYearStart/End` **and** the verbatim
match in `depictedSource` for **26 of 80 records** (all Wildkarte sheets, printed
1853).

- Only the anchored survey phrase is accepted. The loose reading
  “Aufnahmen von XXXX-YYYY” would have written the *engraving* years (1852–1865)
  into the data — 35 cached manifests contain that wording. Rules: range must not
  postdate the imprint, only whole pairs, evidence always stored.
- `scripts/validate.mjs` (the build gate) enforces exactly those invariants, so a
  future harvest cannot quietly drop the evidence.
- **One line changed in maps-3's `detail.js`**: “Zeitraum dieses Blattes filtern”
  preferred the depicted period, which contradicts its own doc comment, the
  slider label “Zeitraum (Publikationsjahr)” and the harness check that reads the
  panel's `Publikationsjahr`; with the new data it would have filtered 1843–1851
  and hidden the very sheet (1853). It now uses the publication range. If you
  prefer a depicted-period filter instead, it needs the slider semantics to say
  so — say the word and it is a two-file change.

### Diagnostic that cost me time — stale headless Chromium

Two harness runs in this iteration (54/56, and a probe that claimed the new data
was missing) were **polluted by leftover `chromium --headless` processes from
earlier runs**: they keep `--remote-debugging-port=9222/9333` and their own HTTP
cache, so a new run silently connects to the *old* browser and reads a
pre-harvest `/data/records.json` (`Cache-Control: max-age=600`). Symptom: the app
“ignores” a fresh data file while `curl` shows it. Fix: kill leftovers before a
run (`pkill -9 -f 'remote-debugging-port=9222'` in a *script*, not on a command
line that contains the pattern) or use a unique debug port. After a clean start:
**61/61**.

**→ all**: `wrangler dev` also serves a *snapshot* of `public/` taken at startup, so
`/data/records.json` stays old after a re-harvest until the dev server is
restarted (`/api/*` reads from disk, which makes the difference look like an app
bug). Restart the preview after `npm run harvest`.

### Next (my area)

- A third provider with world coverage: the Library of Congress JSON API
  (`www.loc.gov/...?fo=json`) + IIIF image service (`tile.loc.gov`, CORS `*`,
  `info.json` verified 200) is reachable from the runner; LOC's `/item/<id>/manifest.json`
  is behind a Cloudflare challenge (403), so it needs the `record.imageService`
  path in `detail.js` (`previewSection` currently requires `iiifManifest`) plus
  `tile.loc.gov` in the allowlist and the `img-src` CSP.
- More ZB Zürich sheets (the `zuz` set is 220 records on 22 pages; the harvest
  only inspects the first 48 candidates) and the `museecarto` set (currently 0
  records survive the stated-bbox rule).

## Iteration 4-6 (2026-10-18, ~22:00–22:2x UTC) — data layer

Landed on `main` as `88131d9` (rebased over maps-2's `45ad3c2`, so the commit hash
on `main` may differ; the content is the same).

### 1. One harvest script, and it also writes `overlays.json`

There were **two** generators: `scripts/harvest-seed.mjs` (older, wrote a smaller
`records.json` without the current selection metadata) and
`scripts/fetch-records.mjs` (the one that actually produced the committed seed).
`npm run harvest` pointed at the old one, so a refresh would have silently
replaced the richer dataset. Fixed:

- `scripts/fetch-records.mjs` now writes `records.json`, `sources.json` **and**
  `overlays.json`; `scripts/harvest-seed.mjs` is deleted.
- `npm run harvest` / `npm run harvest:offline` point at it.
- Every upstream response (OAI pages, manifests, capabilities, tile probes) is
  cached under `.cache/fetch/` (git-ignored); `--offline` reproduces the committed
  files with no network access (verified: byte-identical record set).

### 2. Comparison layers: Siegfried + SWISSIMAGE (answers maps-2's request)

`overlays.json` now has 12 curated layers. Added:

- `ch.swisstopo.hiks-siegfried` – 80 editions 1870–1949, matrix set `3857_17`,
  **maxZoom 17** (read from the TileMatrixSet definition, not assumed).
- `ch.swisstopo.swissimage-product` – 100 aerial editions 1926–2025 + `current`,
  maxZoom 20, and the dedicated `ch.swisstopo.swissimage-product_1946` layer.
- The coverage-metadata layer `…swissimage-product.metadata` stays filtered; the
  `pixelkarte-*` layers remain in the “modern” group.

Records: **55** (28 e-rara maps + 27 swisstopo overlay editions: 13 Zeitreise, 9
Siegfried, 1 SWISSIMAGE 1946, 4 SWISSIMAGE modern). Siegfried decades and the
SWISSIMAGE editions now appear in the year filter and in the results list.

### 3. Honesty fixes in the seed

- The WMTS advertises Zeitreise **1844–1848 but serves empty tiles** (verified at
  z8–z12 for Zürich/Bern/Basel/Lausanne/Lugano). Those editions are no longer
  offered; they are listed in `records.json.skipped` with the probe result.
- `thumbnail` is now a tile the harvest actually **probed as non-empty**;
  `thumbnailPlace` names the probe location (Zürich first, Bern for the 1870
  Siegfried mosaic, which does not cover Zürich yet). No metadata was invented:
  the record title/date still come from the advertised `Time` value.

### 4. Small unblocking edits in other owners' files (please review)

- `public/app/results.js` (maps-2): `isHistorical` now also matches `swissimage`,
  and the optgroup label mentions SWISSIMAGE; without it the new aerial layers
  would have been listed under “Moderne Landeskarten”.
- `public/app/search.js`: I had independently fixed the same TDZ crash as maps-3's
  `6c18514`; I kept **their** version on rebase, no duplicate.

### Verified

- `npm test` 54/54 ✓ (added overlay↔layer and skipped-entry invariants) ·
  `npm run build` ✓ · `npm run check` (incl. `wrangler deploy --dry-run`) ✓
- `scripts/browser-check.mjs` (the shared harness, now 36 checks) against
  `npx wrangler dev`: **36/36** on the integrated tree (maps-1 comparison, maps-2
  marker cards, maps-3 deep-zoom viewer) — 55 records, 37 in the default range,
  Zeitreise tiles render, place search returns 8 swisstopo suggestions, no console
  errors, no failed requests.
- The swisstopo collection pages in `sources.json` were re-verified after an
  earlier guess returned 404: Historische Kartenwerke, Digitale Siegfriedkarte,
  Digitale Dufourkarte, SWISSIMAGE HIST and HIST 1946 all return HTTP 200 with
  matching titles (2026-10-18).
- NOTE: maps-2's `283e48d` supersedes my one-off browser-check unflaking patch;
  I skipped my duplicate on rebase. Nothing else of mine was lost.
- A targeted Siegfried/SWISSIMAGE walkthrough: picker offers all three new layers;
  1860–1910 lists 5 Siegfriedkarte records; 12 Siegfried-1900 tiles load; the
  detail view of a record shows the swisstopo WMTS preview and links to
  `map.geo.admin.ch/?layers=…&time=…`.

### 5. Collection facet support (request to maps-2)

`public/app/records.js` (my file) now supports a collection filter end-to-end on
the data side: `filterRecords(state, records)` honours `state.collection`, and
`facets(records)` returns a `collections` map (5 real series in the seed:
Wildkarte 1:25 000, Schweizer Landkarten, Zeitreise, Siegfriedkarte,
SWISSIMAGE Zeitreise/Luftbilder). `npm test` covers both.

**Request to maps-2:** wire it in `results.js` + `index.html` when you touch the
filter panel next — the brief asks for collection/provider filters and the header
comment of `results.js` already claims collection filtering. Suggested shape:
`#collection-filter` `<select>`, URL key `c`, default `''`; populate from
`facets(records).collections` sorted by name; call
`ctx.store.update({ collection })`. Nothing else in the data layer needs to
change.

### Messages

- **→ maps-2:** the Siegfried request is done (80 editions, maxZoom 17).
  `results.js` got the two-line `isHistorical`/label change above — please keep or
  supersede it consciously. `state.overlay.maxZoom` is now per-layer, so the map
  stops requesting z18 from the 3857_17 Siegfried raster. Consider grouping
  `swissimage` under the historical label in your new UI work.
- **→ maps-3:** the probe/`skipped` fields are additive; the D4 schema is
  unchanged. The harness caught the TDZ crash before I saw it too — thanks.
  `records.json.skipped` now has one documented entry (Zeitreise 1844).
- **→ maps-1:** `sources.json` no longer carries the unused `local` fixture
  provider (records never used it; `records.test.mjs` keeps its own in-memory
  fixture). If any UI copy counts providers, it now reports 2. Docs I touched:
  README, `docs/run.md`, `docs/data-sources.md`.
- **→ all:** `npm run harvest` is safe to run again (cached, bounded, writes all
  three data files).

---

Iteration 1-1 (2026-10-18, UTC). Member `zurich-maps-0`.

## Reaction to the maps-1 contract (accepted)

I arrived with a Vite+TypeScript+Leaflet scaffold plan. `zurich-maps-1` landed the
no-bundler ESM contract on `main` first (D1–D4) and it is a good fit for four
parallel agents: no build race, static assets + worker on Workers, `npx wrangler dev`
preview, `node --test`. **I dropped my scaffold and adopted the maps-1 contract
unchanged** — no competing shell, no bundler. My earlier protocol draft was
withdrawn; `coordination/README.md` stays exactly as maps-1 wrote it.

## Claimed (per the maps-1 status board, plus what I actually took)

- `public/data/sources.json` — provider/source registry (primary record URL,
  identifiers, rights, attribution, retrieval date, endpoints actually used).
- `public/data/records.json` — real, attributed seed records.
- `public/app/records.js` — loader/index/filter/search over records (D4 schema).
- `src/worker/index.js` **handler body** — allowlisted upstream proxy + edge cache
  (maps-1 owns the scaffolding/config; I filled in the body as invited).
- `scripts/**` — reproducible refresh/validation scripts (Node, no deps).
- `docs/SOURCES.md`, `docs/PROGRESS.md`.
- `tests/records.test.mjs` — my data-layer tests only (maps-3 owns the rest of `tests/`).

## Answered messages

- **→ maps-1:** D1–D4 accepted, schema kept exactly. `records.json` validates in
  `node --test`. I do not touch `public/index.html`, `public/styles/**`,
  `public/app/main.js`, `store.js`, `dom.js`, `wrangler.jsonc`.
- **→ maps-2:** records carry `geo` (point) and `extent` (bbox) where the upstream
  publishes them; `records.js` exposes `filterRecords(state, records)` and
  `recordsInBounds(records, bounds)` so the map can synchronise with the result
  list without re-implementing time/provider filtering.
- **→ maps-3:** every record has `recordUrl`, `rights`, `institution`,
  `thumbnail` and (where upstream offers it) `iiifManifest`; thumbnails are
  direct IIIF image URLs so `detail.js` can also build a deeper zoom URL from
  `iiifManifest`.

## Verified upstream facts (checked 2026-10-18; evidence, please re-verify before trusting)

- swisstopo WMTS capabilities `https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml`
  (688 layers, CORS `*`):
  - `ch.swisstopo.zeitreihen` "Zeitreise – Kartenwerke", 178 `Time` values
    `YYYYMMDD` 18441231…20211231, matrix set `3857_18`,
    bbox `5.140242 45.398181 / 11.47757 48.230651`,
    template `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/{Time}/3857/{TileMatrix}/{TileCol}/{TileRow}.png`
  - `ch.swisstopo.hiks-siegfried` "Siegfriedkarte", 80 `Time` values 1870…1949.
  - `ch.swisstopo.hiks-dufour` "Dufourkarte Erstausgabe", single value `current`.
  - These are **georeferenced overlays** (real imagery, no coordinates invented).
- `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=…&type=locations&sr=4326&limit=n`
  → `results[].attrs.{label,lat,lon,geom_st_box2d,origin,rank}`, CORS `*`.
- e-rara IIIF Presentation 2.0 at `https://www.e-rara.ch/i3f/v20/<titleId>/manifest`;
  Image API 2 level2 `…/i3f/v20/<imageId>/info.json` (`supports: cors, regionByPx,
  sizeByW, …`); thumbnails `…/i3f/v21/<imageId>/full/304/0/default.jpg`; manifest
  `metadata` carries title/imprint/holding institution/online-since verbatim.
- e-rara OAI-PMH `https://www.e-rara.ch/oai?verb=Identify` → "Visual Library Server",
  granularity `YYYY-MM-DDThh:mm:ssZ`.
- Canton Zürich tokens (Apache-2.0 repo `Kanton-Zurich/frontend-designsystem@master`,
  `src/assets/css/globals/_variables.scss`): blue `#0070b4`, darkblue `#00407c`,
  cyan `#009ee0`, bordeaux `#b01657`, violet `#7f3da7`, green `#1a7f1f`,
  black scale `#000/#333/#666/#949494/#ccc/#d9d9d9/#f0f0f0/#f7f7f7`, Inter 400/900
  + Helvetica fallback, sizes 4/8/12/16/20/24/28/32/40/48/56/80, breakpoints
  0/320/400/600/840/1024/1280, content width 1168 / text 768 / max 1440, button
  `border-radius: 1px` black-filled with Inter Black, spinner `#009ee0`.
  Accessibility: WCAG 2.2 AA + eCH-0059 (zh.ch "Vorgaben zur Barrierefreiheit").

## Blockers

- No Cloudflare credentials in this runner → deployment stays documented
  (`wrangler deploy --dry-run` verification only).
- Playwright is not installed; `chromium`/`google-chrome` binaries exist, so
  headless screenshots are possible.
