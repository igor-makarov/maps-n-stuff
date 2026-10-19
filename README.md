# Maps n Stuff

Four coordinated Shurik agents build an OldMapsOnline-style historical-map
application using the official Canton Zürich design system and original map
collections, delivered as a **Cloudflare Workers site** with Wrangler configuration
and local preview/deploy commands. The shared brief is in [PROMPT.md](PROMPT.md). Agents choose their own
coordination method and deliver completed, validated changes directly to `main`.

## The application: Kartenzeit

**Kartenzeit** is the product this swarm builds: an OldMapsOnline-style explorer
for historical maps, styled with the official [Canton Zürich design system](https://github.com/Kanton-Zurich/frontend-designsystem)
and fed exclusively from documented original sources (e-rara / Zentralbibliothek
Zürich IIIF + OAI-PMH, swisstopo WMTS geoservices and SearchServer). It is an
independent project and not a cantonal website.

What works today (verified with `wrangler dev` + headless Chromium):

- pan/zoom map on swisstopo base tiles, with georeferenced historical map layers
  (Zeitreise 1850–2021, Siegfriedkarte 1870–1949, Dufourkarte, SWISSIMAGE Zeitreise
  aerial imagery 1946–2020) including edition slider, opacity and attribution;
- place search against the swisstopo search service (proxied and edge-cached by the
  Worker) with keyboard-operable suggestions and “quick pick” places; the same box
  also searches the records themselves (“Karten zum Stichwort …”: title, creator,
  series, institution, shelfmark, imprint), so typing a series or a library name
  finds maps instead of fuzzy place names — the count it offers is the count the
  result list will show, and a query without matches says so honestly;
- **browse the maps that cover a place**: a click on the map (or the map-centre
  button, or `P` with the map focused) filters the list to records whose
  documented footprint contains that point; after a place search a
  “Karten an diesem Ort” chip does the same. The filter is visible above the
  results, carries its own “Punktfilter entfernen” action, draws a crosshair on
  the map and is shareable as `at=lat,lon` (a shared point link opens the map on
  that point when the link does not name its own view);
- **“Ausschnitte”: the documented footprints of the filtered records** drawn as
  outlines on the map (map chip or the inline switch in the map hint, shareable
  as `ex=1`). It answers the question the point filter asks — which part of the
  map does each result claim to cover? Identical extents are one rectangle, a
  hovered row highlights its own footprint, and a status line states how many
  filtered cards document an extent at all (never a guessed one). Colour and
  spacing follow the cantonal palette; the layer is decorative
  (`aria-hidden`, `pointer-events: none`), so the list stays the accessible
  interface;
- publication-year range, collection, type and “only in the current map view”
  filters that drive both the result list and the map markers;
- **Grundkarte chooseable: colour, grey or air photo** — three documented swisstopo
  WMTS layers (`ch.swisstopo.pixelkarte-farbe`, `…-grau`, `ch.swisstopo.swissimage`)
  behind one `aria-pressed` chip per layer under the map, shareable as `base=grau`
  (absent = the colour default) and resolved against the same list the renderer
  uses, so an unknown key falls back to the default instead of breaking the map.
  The grey Landeskarte is the calm background for footprints, markers and the
  historical comparison layers; the air photo is the modern reference for them.
  Switching keeps the view (pan/zoom, markers, footprints) exactly where it was
  and the map badge always credits the layer in use (`© swisstopo`);
- coordinated result list ↔ map selection, list/map/split view switch: a pin (or a
  point pile) selected on the map brings its own row into view in the desktop split
  layout — the sticky map column stays on screen — and marks it for a moment, while
  the same click on a phone deliberately leaves the page where the visitor is;
  every map/marker/footprint/histogram state that the app communicates with a
  background colour also has a border or outline under `forced-colors` (Windows
  high contrast), so a selected pin, row or decade stays recognisable there;
- detail panel with publication vs depicted dates, institution, shelfmark, rights,
  an interactive IIIF deep-zoom viewer (region requests, drag/pinch/keyboard, sheet
  navigation, real fullscreen) whose visible cut-out is shareable (`?vv=x,y,w,h`,
  written debounced while zooming/panning; a shared link reopens exactly that
  region, an impossible value is dropped and “Ganzes Blatt” clears it), a link to
  the library's own viewer and a prominent
  link to the original record — plus “use this sheet's period as the time filter”;
  a work with more than twelve sheets (the seed's largest has 65) also
  gets a “Blatt” select for the direct jump to any sheet, and the sheet strip only
  fetches the thumbnails that come into view;
  when the image service is unreachable the panel says so in plain German and keeps
  the metadata, the thumbnail and the provider link (verified by a check that blocks
  the upstream on purpose); a “Weitere Karten dieser Sammlung” list leads from one
  sheet to the other sheets of the same upstream series (and to the filtered result
  list) — series names and counts come from the records, nothing is inferred;
- a comparison list: pin up to four records from the result list, the detail
  panel or a shared `?cmp=…` link, and put two or more of them side by side with
  their real IIIF/WMTS previews, metadata and links back to the original records;
  a pane with a IIIF manifest is an **interactive viewer**, and “Ausschnitte
  gekoppelt” follows every zoom/pan in the other panes — mapped through the extent
  each record documents in the catalogue, so the same place stays in view (the
  hint names that basis and that it is not a georeference; the switch turns it
  off, and a record without a documented extent simply stays independent);
  the pinned list is also kept in this browser (`kartenzeit.cmp.v1`, only
  locally, cleared by “Liste leeren”), so a returning visitor finds their own
  selection again; the visible cut-out of each pane is shareable state of its own
  (`cvv`): the comparison writes it debounced, a shared link restores every pane
  it names — and a link that names one pane opens the same place in the others,
  because that is what the coupling promises — while “Ganzes Blatt” in a pane
  clears its entry (the button is disabled while the pane already shows the whole
  sheet);
- a map-first shell: the intro is a compact band from 1024 px, so the map and the
  result controls are on the first screen at desktop sizes (measured: map starts
  at 612 px of a 900 px viewport), with a “Direkt zur Karte” link, a keyboard
  route to every map action and the cantonal “Nach oben” control once the page
  is scrolled; below 600 px the hero hands its stock figures to “Über das
  Projekt” (same data, `#about-facts`) so the map still starts on the first phone
  screen (measured at 390×844: map top 483 px with 361 px of map visible, before
  the 722 px / 122 px of iteration 7-16), and below the cantonal 400 px
  breakpoint the very small phones win the map its first strip: the design note,
  the hero lead and its two links yield to it (the sentence reads complete in
  “Über das Projekt”, the nav and footer keep the wording), so 320×640 shows
  133 px of map instead of none;
- honest loading and outage states: the results area starts with a visible
  “Bestand wird geladen …” block (cantonal spinner) and `aria-busy` on the list,
  both cleared when the seed arrives — measured with a throttled connection
  (~40 kB/s: the block is on screen for seconds instead of a blank panel); the
  “Zeitraum” area shows a “Jahresverteilung lädt …” placeholder until the chart
  can be built from the records, and the browser check throttles the connection
  to keep both there; if
  `/data/records.json` cannot be fetched, the panel says so in plain German, the
  toolbar count reads “Bestand nicht geladen” instead of pretending to load, and
  the raw browser string stays in the console (`title` attribute) — the browser
  check blocks the seed file on purpose to keep it that way;
- the seed's own provenance is visible in the app: “Quellen und Rechte” lists
  every provider with attribution, rights, homepage and OAI-PMH endpoint and
  states the harvest date (`Datenstand`, read from `records.json.generatedAt`);
- shareable URL state (`q`, `from`, `to`, `p`, `t`, `c`, `base`, `vp`, `ex`, `at`, `place`, `lat`, `lon`,
  `z`, `sel`, `sh`, `vv`, `view`, `sort`, `ov`, `ot`, `cmp`, `cvv`) and a keyboard route for every
  map action (`sh` = sheet of a multi-sheet digitised work; the thumbnail strip in
  the detail viewer is one tab stop and ←/→/Home/End walk the sheets, so a
  26-sheet work does not add 26 stops; `vv` = visible region of that sheet in the
  IIIF viewer, so a permalink reopens the exact cut-out; `cvv` = the cut-outs of
  the comparison panes, one `id@x,y,w,h` per pane and keyed by record id, so a
  shared comparison opens on the same place in both sheets and each pane's
  “Ganzes Blatt” clears its own entry; `at` = point filter). The
  **browser's back and forward buttons work**: a search, a filter or a selected
  record is a history step, while panning the map and dragging the year control
  only replace the current entry (a typed search is one step, not one per
  keystroke, and a pause in the middle of a query does not split it either), and
  the app's own start-up corrections never consume a step — so “back” walks the
  exploration instead of leaving the site;

```sh
npm install
npm run dev      # http://127.0.0.1:8787  (static assets + /api/* Worker)
npm run check    # build validation + node --test + wrangler deploy --dry-run
```

Licensing and credits: the application source is MIT ([LICENSE](LICENSE)); fonts,
design tokens, map data and digitised imagery keep their own licences and
attribution requirements, all listed with their sources in
[NOTICE.md](NOTICE.md) and [docs/data-sources.md](docs/data-sources.md).
`public/robots.txt` allows crawling; there is no `sitemap.xml` because a Workers
project does not know its production host at build time.

Cloudflare build settings (Workers Builds): root directory `/`, build command
`npm run build`, deploy command `npx wrangler deploy`; no secrets or bindings
beyond the `ASSETS` static-asset binding. `public/_headers` adds the security
headers (CSP, `nosniff`, referrer/frame/permissions policy) and cache lifetimes
for the Workers static assets. Details, API description, data refresh
and troubleshooting: [docs/run.md](docs/run.md). Design derivation (tokens,
typography, indentation, focus): [docs/design-system.md](docs/design-system.md).
Source registry and verification evidence: [docs/data-sources.md](docs/data-sources.md).

Known limitations: the seed set holds 199 records (172 e-rara maps and atlases — 26 ZB Zürich
Wildkarte sheets, 56 Swiss maps from ETH-Bibliothek holdings (1547–1900, after the
7-19 widening of the `landkarten` window), 47 Zürich plans and
canton maps found through the catalogue's SRU search (1852 “Plan der Stadt Zürich
nach Breitinger”, the 1754 “Plan des Zürich-Sees”, the 1852/1858/1860 canton maps),
11 further Zürich-region maps from three more SRU questions (18th-century lake
prospects, the 1875–1881 Übersichtspläne, the 1896 Zürichsee map, 1908/1919
sheets), 10 city ground and site plans (the 1696/1705 fortress plans, the 1800
and 1838 city plans, the 1881 quay and 1890 tramway situations), 21 overview maps
of Europe and the world (1787–1914, extent centre deliberately outside the
canton, at least 5° of span; the 7-20 country keywords add German, Italian,
Austrian and Franco-German sheets to the continent maps) and 1 map from the
Bibliothèque de Genève) — plus 27 georeferenced swisstopo overlay editions; the UI
states the real count and `records.json.selection`
documents the rule per set, including the `landkarten` window (30 of the set's 2335
records are read, 125 candidates are pooled and 56 kept as the union of the oldest
26 and a per-decade spread, which is what reaches the 16th–18th-century sheets),
the `museecarto` set that is probed but
yields no record because its manifests state no extent, the SRU sets whose
candidates must have the centre of their stated extent inside the canton of
Zürich's bounding box as swisstopo's gazetteer states it (the world set requires
the mirror image: centre outside the window and ≥ 5° span), the documented tie-break
that prefers the Zentralbibliothek Zürich copy of a sheet, and the rule that a
record whose holding library is stated by neither the manifest nor the catalogue
corpus is dropped and listed in `skipped` instead of being attributed.
One of the records is a 35-sheet digitised canton map, so the viewer's sheet strip
can now hold many sheets. The map
implementation in `public/app/map.js` is our own; no third-party map library is
bundled. Without network access the tiles
and IIIF images stay empty while metadata remains readable (the detail panel then
keeps the metadata, the provider links and an explanation).

## Swarm configuration

- Action: [`igor-makarov/shurik@v2`](https://github.com/igor-makarov/shurik)
- Model: `opencode-go/deepseek-v4.1-flash`, reasoning `max`
- Members: `zurich-maps-0`, `zurich-maps-1`, `zurich-maps-2`, `zurich-maps-3`
- Work per iteration: 1,800 seconds; all automatic task commits disabled (`0`)
- Wait between iterations: zero; no overall deadline
- Delivery: `main`, with draft PR creation disabled

The official `@v2` release supports `checkpoint-seconds: 0` to disable all automatic
task commits, including initialization, iteration start, periodic checkpoints,
and iteration end. The workflow uses this supported setting directly.

Shurik itself gives each member an independent task branch and
`shurik-control/<member-id>` branch. The brief explicitly tells agents to coordinate
and make their own product commits and pushes to `main`. Shurik still persists
session/control state and publishes existing agent-created commits to the assigned
task branch; it never stages or commits unfinished task edits in this mode.
Agents must preserve their task branch's published history so these pushes can
fast-forward. Uncommitted edits are lost between runners, and an abrupt
interruption can also lose unpublished commits and session history.
Shurik does not provide built-in inter-agent messaging or automatic integration.

## Initial launch

Add the **`OPENCODE_API_KEY`** repository Actions secret with access to the model.
No credential belongs in the launch JSON, prompt, Git history, or dispatch inputs.

Pushing a change to [`.github/shurik/launch.json`](.github/shurik/launch.json) on
`main` starts the four-member swarm if no members have been initialized, through
[`.github/workflows/shurik.yml`](.github/workflows/shurik.yml). Ordinary product,
prompt, or workflow commits do not trigger another swarm. Updating the launch
request for an existing swarm also skips initialization; use the brief-update
workflow to apply settings to its saved members. The control job checks
for the secret before creating loops; if it is missing, add it and rerun that
failed job. If startup has already created any members, inspect their state before
retrying: Shurik rejects reusing initialized loop IDs.

Changes to `PROMPT.md` on `main` run the brief-update workflow: it stops each
existing member, copies only the latest brief onto its task branch, and resumes
the saved loop. Product work and the agents' chosen coordination method remain
theirs to manage. This workflow can also be run manually after a failed update.
It resumes all four with all automatic task commits disabled.

Cloudflare deployment credentials are not forwarded to the swarm. Agents prepare
and validate the application source and Workers configuration, and document the
required root directory, build command, and deploy command. **Cloudflare handles
the production build and deployment from `main`.** The swarm does not deploy.

The workflow needs contents and Actions write permissions. Agents also need to be
able to push to `main` under the repository's branch rules. Its scheduled recovery
runs every 15 minutes, subject to GitHub scheduling delays. Loops keep iterating
until stopped or given a deadline; work-seconds is a time budget, not a spending
cap. The provider validates availability and support for `max`; do not silently
substitute a model or lower reasoning.

## Control existing members

Use **Actions → Shurik → Run workflow** on `main`, or the GitHub CLI. Stop/resume
requires an individual member ID, not the swarm prefix. For example:

```sh
gh workflow run shurik.yml --ref main \
  -f command=stop -f loop_id=zurich-maps-0

gh workflow run shurik.yml --ref main \
  -f command=resume -f loop_id=zurich-maps-0
```

Leave model, swarm, and timing fields blank when resuming to retain their saved
values. A blank resume deadline clears any previous deadline. Stop all four:

```sh
for member in zurich-maps-0 zurich-maps-1 zurich-maps-2 zurich-maps-3; do
  gh workflow run shurik.yml --ref main -f command=stop -f loop_id="$member"
done
```

For a genuinely new swarm, choose a fresh prefix and use explicit settings:

```sh
gh workflow run shurik.yml --ref main \
  -f command=start -f loop_id=zurich-maps-next \
  -f model='{"provider":"opencode-go","name":"deepseek-v4.1-flash","reasoning":"max"}' \
  -f swarm='{"agents":4}' -f create_pr=false -f prompt=PROMPT.md
```
