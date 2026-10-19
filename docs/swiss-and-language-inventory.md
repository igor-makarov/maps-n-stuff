# Swiss-specific features and remaining German

Inspected 19 October 2026, starting at commit `ad500026`. This is a source-code
and bundled-data inventory, with recommendations; no product features or records
were removed. The global/English correction retained too much functionality from
the original Zürich-first implementation. Some surviving explanatory Swiss copy
was deliberately added by that correction, rather than being untouched swarm text.

Updated requirement: **georeferencing is strongly preferred, not required for
catalogue inclusion**. Rights-cleared scans may be browseable without an
alignment. Accurate overlays still require a real transformation and checks.

## Product inventory

| Item and implementation | Recommended disposition |
| --- | --- |
| **Three Swiss basemap choices**, `public/app/map.js:54`: national map colour (`farbe`), national map grey (`grau`), Swiss aerial imagery (`luftbild`). The aerial chip merely says “Aerial”. | **Remove from the global basemap control.** Offer worldwide reference layers there; regional services can be offered contextually later. Preserve old URL keys as compatibility mappings if necessary. |
| **Swiss basemap coverage**, `public/app/map.js:630`: selected service is rendered directly, with no coverage-based fallback to OSM. The colour-map hint nevertheless suggests worldwide views use OSM. | Correct by removing/generalizing these choices. A regional service can leave an unhelpful background elsewhere. This conclusion follows the code path; live tiles were not tested. |
| **Dedicated Swiss overlay panel**, `public/index.html:198`, `public/app/results.js:296`: always present, with historical/modern Swiss groups. | **Replace with a general historical-map layer control**, based on selected map and geographic coverage. Retain legitimate Swiss historical maps as ordinary regional holdings. |
| **Twelve swisstopo overlay layers**, `public/data/overlays.json`: five historical/aerial services and seven national-map products. | **Remove the seven modern national-map products from the historical-overlay picker.** Keep the five historical/aerial services as optional regional sources without special global promotion. |
| **Swiss promotion**, `public/app/main.js:130`, `:146`, `public/index.html:310`, `:349`: hero tag, facts tooltip, About and footer emphasize Swiss overlays. | Remove Swiss-specific marketing from general copy. Show active-layer attribution; preserve necessary credits in Sources/NOTICE while providers remain supported. |
| **Switzerland-only search fallback**, `src/worker/index.js:99`: empty/failed Nominatim queries fall through to swisstopo SearchServer. | Replace with a global fallback or a clear global-service error; retain swisstopo only as an explicit regional supplement. It cannot restore worldwide search during an outage. |
| **Swiss assumptions in shared layer code**, `public/app/results.js:302`, `detail.js:233`, `map.js:1071`: historical detection by Swiss ID substrings, default swisstopo credits. | Generalize to explicit provider, date/history and coverage fields. Never assign swisstopo credit to a future unknown provider. |
| **Swiss service permissions**, `src/worker/allowlist.js:19`, `:23`, `:24`, `public/_headers`. | Keep only paths required by supported adapters. The blanket `data.geo.admin.ch` path entry appears unused by the current app/harvester. Swiss institutional image access is legitimate when its holdings remain. |
| **Catalogue concentration**, `public/data/records.json`: 186 e-rara, 27 swisstopo, eight LoC records. **213/221 (96.4%) come through Swiss institutions/providers**, although some depict other countries or the world. | Keep valid historical holdings and expand global sources. Swiss custody and Swiss subject matter are different facts; deleting all Swiss-held records would also remove world maps. |
| **Swiss provider descriptions**, `public/data/sources.json:8`, `:9`. | Keep accurate source/holding identities. Write our provider descriptions in English; proper institutional names can retain their official language. |
| **Canton-derived styling**, `public/styles/zh-tokens.css`, `zh-base.css`, `zh-components.css`, self-hosted Inter and `zh-*` classes. | **Keep the requested visual language.** CSS identifiers are internal. Rewrite obsolete “recognisably Cantonal” guidance; renaming tokens is optional maintenance. |
| **Design credit**, `public/index.html:322`, `NOTICE.md`, design docs. | Keep a modest accurate design-reference credit. The original guidance link opens a German external page; this is separate from untranslated local UI. |
| **Operational names**, Worker/package `zurich-maps`, Shurik loop/control names, coordination files, localStorage `kartenzeit.cmp.v1`. | Low priority. Deliberately migrate deployment/storage/control identifiers if renamed; do not accidentally create a new Worker or hide saved comparisons. |
| **Dead Swiss navigation**, `public/app/map.js:112`, `:1300`: `ZURICH` export and `fitswitzerland` handler have no current HTML button. The old `zurich` command now resets the world. | Remove dead code/stale tests or retain only documented compatibility. These are not current default navigation. |
| **Swiss-only tests and old runbooks**, `tests/data.test.mjs:140`, map tests, `docs/run.md`, design/coordination docs. | Replace country-specific architecture requirements with provider-neutral contracts. Keep Swiss tests inside that adapter; archive obsolete German UI guidance so agents do not restore it. |

The five historical/aerial layer IDs are `ch.swisstopo.zeitreihen`,
`ch.swisstopo.hiks-siegfried`, `ch.swisstopo.hiks-dufour`,
`ch.swisstopo.swissimage-product`, `ch.swisstopo.swissimage-product_1946`.
The seven other products have the same `ch.swisstopo.` prefix:
`pixelkarte-farbe-pk1000.noscale`, `pixelkarte-farbe-pk500.noscale`,
`pixelkarte-farbe-pk200.noscale`, `pixelkarte-farbe-pk100.noscale`,
`pixelkarte-farbe-pk50.noscale`, `pixelkarte-farbe-pk25.noscale`,
`pixelkarte-grau-pk1000.noscale`. Some national-map services have older editions,
but this fixed Swiss reference-map menu does not constitute a global catalogue.

## Harvest bias that needs replacing

- **Zürich-specific discovery:** `scripts/fetch-records.mjs:943`, `:1053`, `:1086`
  search Zürich plans, its canton and its old maps; Wildkarte gets a dedicated
  26-sheet selection at `:1199`. Keep these only as optional collection adapters.
- **Canton-boundary dependency:** `zurichCantonWindow()` (`:437`) requests a
  Swiss canton bbox. Several pools, including the world pool (`:1517`), are
  skipped if it is unavailable. Global harvesting must not depend on this.
- **Foreign city maps excluded:** `isWorldOverview` (`:1524`) requires a centre
  outside Zürich and a span of at least five degrees. Remove this rule: local
  maps outside Switzerland are essential to worldwide place search.
- **Prefer the canton library:** `byYearThenCantonLibrary` (`:1339`) prefers ZB
  Zürich copies because that library belongs to the design reference's canton.
  Replace with criteria such as image quality, rights clarity, stable access
  and available georeferencing; retain alternate-copy provenance.
- **Sampling/edition loss:** candidate windows, count caps, per-decade quotas
  and leading-title deduplication preserve a small curated seed. Replace them
  with complete paginated discovery and edition/sheet/scan identities. Keep
  bounded development fixtures separately.
- **Swiss preview probes:** `:777` tries Zürich, Bern and Basel for swisstopo
  thumbnails. Those are reasonable inside a regional adapter; Zürich must not
  become the application's general thumbnail or home-view assumption.
- **Required bboxes:** most e-rara channels admit only records with a stated
  catalogue extent. Under the clarified requirement, eligible scans without
  one should still be browseable, with an honest location/alignment status.

Related rights issue found during this inspection: `manifestRecord` (`:365`)
defaults missing candidate rights to `PDM 1.0`, and the Alma resolution path
(`:611`) assigns that value. Missing rights need evidence, not an optimistic
default. Review these paths before expanding; this does not prove that every
current record lacks valid rights evidence.

## German: source metadata versus authored text

| Example | Actual origin | Recommendation |
| --- | --- | --- |
| `Das Zürychgow`, historical `Karte des Cantons Zürich …` titles, imprints such as `[Verlag nicht ermittelbar]` | Original archive metadata transcribed into records. | Preserve originals; optionally add separately identified English translations. |
| `Zentralbibliothek Zürich`, `ETH-Bibliothek Zürich`, `Universitätsbibliothek Bern` | Proper names of real holding institutions. | Preserve official names; an English descriptive name can supplement them. |
| `Übersichtskarten von Europa und der Welt`, `Pläne aus Zürich (Stadt und Umgebung)`, `Zürich und Umgebung (Kanton, Stadt und See)`, `Grundrisse und Situationspläne der Stadt Zürich` | **Synthetic collection labels authored in the harvester** (`:945`, `:959`, `:1015`, `:1055`), then shown in collection facets/details. | Translate/replace with English labels. Being stored in JSON does not make text original archive metadata. |
| `Zeitreise – Kartenwerke, Ausgabe …`, `Siegfriedkarte … Ausgabe …`, `SWISSIMAGE Zeitreise, Luftbild …` | **Generated titles for 27 records**, from `scripts/fetch-records.mjs:697`, `:705`, `:713`, `:723`. | Use English display titles and “edition”/“aerial imagery”; retain official series names separately. |
| `Quellenangabe «©swisstopo» erforderlich` | **Hardcoded summary**, `scripts/fetch-records.mjs:745`, repeated in all 27 swisstopo record rights and all 12 overlay licence strings; shown by `results.js:396`. | Translate the summary to “Attribution © swisstopo required”; preserve credit and authoritative terms. |
| `Landeskarte …`, `Dufourkarte Erstausgabe`, `Zeitreise …`, `Siegfriedkarte` in the layer picker | Primarily upstream WMTS capability titles, copied at `scripts/fetch-records.mjs:896` and rendered at `results.js:332`. | Use English display labels for retained layers; preserve official source title/ID in provenance. |
| `… digitalisierte Seiten` under “Extent” | **Untranslated interface literal**, `public/app/detail.js:823`. | Change to “Digitized pages” / “N pages”. “Extent” is also the wrong heading for a page count. |
| `Kein IIIF-Manifest (JSON erwartet).` | **Untranslated parser error**, `public/app/iiif.js:112`. Current `describeUpstreamError` masks it with a generic English message. | Translate for diagnostics. It is latent, not proof of normally visible German error text. |
| IIIF canvas/sheet names in options, tooltips, preview alt text and captions | Source labels. `labelText` (`public/app/iiif.js:32`) prefers English, then untagged, then explicitly German. | Preserve original names if no translation exists; keep English controls and remove German's privileged fallback position in a global multilingual catalogue. |
| German place names, text printed on scans or baked into Swiss tiles | Provider/map content. Nominatim already uses `accept-language=en`; the Swiss fallback has no equivalent language parameter. | Prefer English service labels when supported; printed historical map text is part of the image. |
| `farbe`, `grau`, `luftbild`, `kartenzeit.cmp.v1`, code comments, old screenshots/docs | Internal compatibility/development material. | Cosmetic maintenance or deliberate migration. `/de/` or `lang=de` source links can also open German external pages; prefer verified English equivalents when available. |

All current records have a collection value; **213 have German collection
labels**, with a mixture of authored buckets and genuine source-series names.
These must not all be defended as original transcriptions.

## Already corrected

The fresh-visit basemap and initial position are worldwide OSM/world, main
navigation is English, quick picks are Cairo/Tokyo/Mexico City/London/New
York/São Paulo, and the original Meridian Atlas globe replaces the canton-like
shield. The History view contains global political polygons. Its upstream
dataset name **Historical Basemaps** does not mean a Swiss basemap service.

Recommended order: remove the three regional basemap choices, remove Swiss
promotion/generalize the layer picker, correct authored German, replace harvest
selection/duplicate rules, then expand global sources. Retain historical
holdings, their provenance and the requested design language.

No deployed UI, map records, service allowlists or Worker identity were changed
by this inventory. Prospective removals have not been browser-tested.
