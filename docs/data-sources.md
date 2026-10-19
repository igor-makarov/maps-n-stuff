# Data sources — registry, rights and verification evidence

Machine-readable registry: [`public/data/sources.json`](../public/data/sources.json)
(providers, endpoints actually used, rights, attribution, retrieval date) and
[`public/data/overlays.json`](../public/data/overlays.json) (georeferenced map
layers). Refresh script: [`scripts/fetch-records.mjs`](../scripts/fetch-records.mjs)
(`npm run harvest`, `npm run harvest:offline`).
All checks below were run on **2026-10-18** (UTC) from this repository.

OldMapsOnline was used only for *UX research* (information architecture: search →
time filter → result list → map → detail → original collection). No aggregator
endpoint is called by the application.

## 1. e-rara — digitised prints of Swiss libraries (Zentralbibliothek Zürich)

| Field | Value |
| --- | --- |
| Provider record (interface) | <https://www.e-rara.ch/> — ZB Zürich interface `zuz` |
| Primary record URL | `https://www.e-rara.ch/doi/10.3931/e-rara-<id>` (DOI resolves to the title page) |
| Identifiers used | e-rara title id / DOI suffix (`e-rara-22142031`), IIIF title id, IIIF image id |
| Metadata endpoint | `https://www.e-rara.ch/oai?verb=ListRecords&metadataPrefix=oai_dc&set=<setSpec>` (OAI-PMH 2.0, `oai_dc`; sets used: `zuz`, `landkarten`, `cartesgeneve`, `museecarto` — `ListSets` is paginated, 105 sets in 11 pages) |
| Discovery endpoint (SRU) | `https://www.e-rara.ch/sru?operation=searchRetrieve&version=1.2&query=<cql>&startRecord=<n>&maximumRecords=100&recordSchema=mods` (standard SRU 1.2 with CQL; the search indexes that answer are `dc.title`, `dc.subject` and `dc.creator` — `dc.type`, `dc.genre`, `dc.format` and `dc.coverage` always answer 0 records). MODS records state the IIIF id and holding corpus verbatim (`<vl:id>`, `<vl:prefix>`) plus a `<coordinates>` statement; a hit is confirmed with `oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:www.e-rara.ch:<titleId>` before it becomes a record |
| IIIF manifest (Presentation API 2.0) | `https://www.e-rara.ch/i3f/v20/<titleId>/manifest` |
| IIIF image service (Image API 2, level 2) | `https://www.e-rara.ch/i3f/v20/<imageId>/full/<size>/0/default.jpg` |
| Holding institution | per record from the manifest `Besitzende Institution` — in the seed (109 records): ETH-Bibliothek Zürich (44), Zentralbibliothek Zürich (33), swisstopo (27 overlays), Universitätsbibliothek Bern (4), Bibliothèque de Genève (1). The registry's `institutions` list is derived from the harvested records, so it cannot drift; a set whose manifests do not name an institution (see `museecarto` below) contributes no record. When a manifest omits the field, the library is taken from the **corpus the catalogue itself states** (`<vl:prefix>` of an SRU hit, the `setSpec` of an OAI set, or the `og:url` of the DOI landing page — `zuz`, `zut`, `bes_1`, `gep_r`); a corpus the harvest cannot name produces no record, and the drop is listed in `records.json.skipped` (no library is ever defaulted) |
| Rights | per record from `dc:rights` — the seed set is `PDM 1.0` (Public Domain Mark) |
| Attribution | “Zentralbibliothek Zürich via e-rara” |
| Related collection context | <https://www.zb.uzh.ch/de/sammlungen/spezialsammlungen/karten-und-panoramen> (ZB Zürich, Karten und Panoramen) |

Verification evidence (curl headers):

```
GET https://www.e-rara.ch/i3f/v20/3602/manifest      -> 200 application/json, access-control-allow-origin: *
GET https://www.e-rara.ch/i3f/v20/3604/full/200/0/default.jpg -> 200 image/jpeg   (no CORS header)
GET https://www.zb.uzh.ch/de/sammlungen/…/karten-und-panoramen -> 200
```

Consequence for the app: IIIF **manifests** can be fetched from the browser
(CORS `*`); **images** are loaded as plain `<img>` (no CORS needed). `/api/fetch`
exists only as a fallback and is restricted to `www.e-rara.ch/i3f/**`.

Field mapping (nothing invented):

| Record field | Upstream source |
| --- | --- |
| `title` | IIIF manifest `label` (verbatim); falls back to `dc:title` |
| `creators` | `oai_dc` `dc:creator` (verbatim, may be empty) |
| `yearStart`/`yearEnd` | publication year from `dc:date`, else parsed from the manifest `Impressum` |
| `depictedYearStart`/`depictedYearEnd` | only when the record itself states a survey/map date; otherwise `null` (never derived from the publication year). The harvest accepts exactly one anchored phrase from the e-rara manifest — “in den Jahren 1843-1851 gemachten Aufnahmen” — and stores the verbatim match in `depictedSource`; 27 of the 109 records (all Zürich Wildkarte sheets and the 1852 canton map, printed 1853) carry it. A bare “Aufnahmen von 1852-1865” is *rejected*: on those sheets that range is the engraving, not the survey, and 35 cached manifests contain exactly that trap. Records whose *title* names a different map year (e.g. “Stadtplan von Winterthur vom Jahre 1755”, published 1919) keep the publication year as `yearStart` and `depictedYearStart: null`; the title is shown verbatim, so the difference is visible instead of guessed |
| `institution` | manifest `Besitzende Institution` (first institution before the comma) |
| `shelfmark` | the part of the manifest `Besitzende Institution` after the comma, verbatim (`Zentralbibliothek Zürich, 4 Lb 06: 9` → `4 Lb 06: 9`); 82 of 109 records state one (all e-rara records; swisstopo states no signature), the others show “nicht angegeben” in the detail view |
| `recordUrl` | the DOI landing page (`https://www.e-rara.ch/doi/10.3931/e-rara-<id>`) |
| `thumbnail` | IIIF thumbnail from the manifest (`…/full/304/0/default.jpg`) |
| `imageService` | IIIF Image API 2 service id of the first canvas |
| `rights` | verbatim `dc:rights` (the seed set is `PDM 1.0`) |
| `extent` / `geo` | parsed from the manifest `Kartendaten` statement; `geo` is the centre of that stated bbox, never a guessed point |
| `imprint`, `collection`, `sheet` | manifest `Impressum`; the OAI set / sheet name from the manifest label |
| `imageService` | IIIF Image API 2 service id of the first canvas |
| `canvasCount` | number of canvases in the manifest (`sequences[0].canvases.length`) — 38 of 39 records state it, four are real multi-sheet works (2–3 sheets) |
| `viewerUrl` | the library's own deep-zoom viewer: the DOI landing page states the holding corpus in `og:url` (`http://www.e-rara.ch/<corpus>/<id>`); the harvest keeps only the corpus after checking `<id>` against the manifest title id and stores `https://www.e-rara.ch/<corpus>/content/zoom/<id>`. For SRU-discovered records the corpus comes verbatim from the catalogue record (`<vl:prefix>`), so no landing page request is needed. Corpora in the seed: `zut` 44, `zuz` 33, `bes_1` 4, `gep_r` 1 (all 82 e-rara records have one). Nothing is constructed when neither states it |

Selection rule (no hand-picked titles): every map record of an OAI set that is
not a series volume, oldest first, with a cap per set (ZB Wildkarte 26 sheets,
`landkarten` 26, `cartesgeneve` 14). A record is kept only when the manifest
states a `Kartendaten` bbox and an upstream year; duplicates of the same work are
dropped by leading title. The per-set numbers (`considered`/`kept`/`rule`) are
written into `records.json.selection`.

### Zürich plans and the Zürich region via SRU (added 7-14, extended 7-15)

The OAI sets are unsorted *ingest* order, so single sheets and city plans are hard
to reach by paging them (pages 32–50 of `zuz` yield three map candidates, all the
same 16th-century atlas). The platform's own **SRU 1.2** service searches the
catalogue instead, so the harvest asks it five documented CQL questions and keeps
the results that survive the same gates as every other record:

```
dc.title=Plan  and dc.subject=Zürich     104 hits   → “Pläne aus Zürich (Stadt und Umgebung)”, cap 18
dc.title=Karte and dc.subject=Zürich      63 hits   → same set
dc.title=Umgebung  and dc.subject=Zürich  45 hits   → “Zürich und Umgebung (Kanton, Stadt und See)”, cap 16
dc.subject=Zürichsee                      25 hits   → same set
dc.title=Stadtplan and dc.subject=Zürich   2 hits   → same set
```

`dc.title=Ansicht and dc.subject=Zürich` (43 hits) and
`dc.title=Vogelschau and dc.subject=Zürich` (2 hits) were probed on 2026-10-18
and yield **no map record with a stated extent** (they answer facade views and
viewsheds of buildings), so they are deliberately not queried.

Gates, in order: map genre and a stated publication year and a stated MODS
`<coordinates>` statement in the SRU record (a candidate without them never costs
a manifest request) → not already in the seed → `oai?verb=GetRecord` confirms the
record (`dc:rights`, DOI, map type, year) → the IIIF manifest must state a
`Kartendaten` extent and the holding institution → **the centre of that stated
extent must lie inside the canton of Zürich's bounding box** → one entry per title
and year, oldest first.

The two sets share the title/year dedupe, so a sheet both searches find is kept
once. The plans set is capped at 18 records; the region set is capped at 16 **and
at three records per publication decade**, because “Umgebung”/“Zürichsee” material
clusters in a few decades — with a plain oldest-first cap the whole 20th century
of the set fell out of the selection again.

The canton window is not a guess: it is read at harvest time from swisstopo's own
gazetteer (`SearchServer?searchText=Zürich&type=locations&origins=kantone`, the
GG25 canton layer) and stored in
`records.json.selection['e-rara:sru-zurich-plans'].cantonWindow` and
`…['e-rara:sru-zurich-region'].cantonWindow` — 2026-10-18:
`8.35184 … 8.995768 E / 47.1557 … 47.697043 N`. It prevents a keyword hit for a
Switzerland- or Germany-wide map (e.g. “Helvetia universa: 28. Karte von der
Schweiz”, “Germania universa: 7”) from entering a Zürich set: those four
candidates were kept in the first run and are excluded now — as are the region
hits outside the canton that the new queries return (`Stadtplan von Riga`, the
1840 “Rigi-Berg und seine Umgebungen”, Baden and Luzern surroundings, Lugano
1913). If the gazetteer cannot be reached, the whole SRU set is skipped rather
than shipped ungated.

Result: **18 + 11 records** (`considered` 92 and 24 candidates with a stated
extent). The plans set is city plans (“Plan der Stadt Zürich nach Breitinger”,
1852–1867), the canton maps of 1852/1858/1860, the 1754 “Plan des Zürich-Sees”,
the 1768–1793 military exercise plans, Oberstrass 1869 and the 1871 geological
plan. The region set adds the 18th-century lake material (1766 “Prospectus unius
partis lacus Tigurini”, 1780 “Le lac de Zürich avec ses environs”, both
Universitätsbibliothek Bern), the Übersichtspläne of 1875/1876/1879/1881, the 1896
“Spezialkarte des Zürichsee's mit Umgebung”, the 1908 Zürichsee basin and
Turbenthal sheets and the 1919 Randmoränen and Winterthur city plan — so the
e-rara part of the seed now spans 1754–1919 instead of 1754–1871.

Discovery windows (2026-10-18) — the sets are not map sets, so the harvest reads
a bounded sample of each and the window sizes are part of the method:

| OAI set | What it holds | Pages read | Candidate window | Kept |
| --- | --- | --- | --- | --- |
| `zuz` | the whole ZB Zürich corpus, **54,999 records** | 32 (320 records) | 72 maps | 26 Wildkarte sheets |
| `landkarten` | “Schweizer Landkarten aus vier Jahrhunderten” | 12 (120) | 50 maps | 26 |
| `cartesgeneve` | Geneva and surroundings | 6 (60) | 40 maps | 1 (1837 “Geneva”, Bibliothèque de Genève) |
| `museecarto` | world maps (Mappae mundi and reproductions) | 6 (54) | 20 maps | **0** |
| SRU `dc.title=Plan/Karte and dc.subject=Zürich` | Zürich plans and canton maps (single sheets, not a series) | 3 SRU pages (167 hits) | 92 candidates with year + stated extent → 44 with a manifest request | **18** |
| SRU `dc.title=Umgebung / dc.subject=Zürichsee / dc.title=Stadtplan` + `dc.subject=Zürich` | Zürich and its surroundings, the lake, city plans | 3 SRU pages (72 hits) | 24 candidates with year + stated extent → 40 with a manifest request | **11** |

`cartesgeneve` documents a real trap: the window is sliced by *count* after
sorting by year, so a narrow window silently drops 19th-century sheets behind
older ones — the 1837 Geneva sheet disappeared at a 14-item window and is only
back because the window is 40 candidates. `museecarto` is probed on every run and
contributes **0 records**: no manifest of that set states a `Kartendaten` extent,
and its works come from several libraries, so a record would also need the holding
library to be stated by the manifest or by its catalogue corpus — no library is
ever guessed (a record without one is dropped and listed in `skipped`). Both facts are visible in `records.json.selection` and in the
`museecarto` entry of `sources.json`.

## 2. swisstopo — Federal Office of Topography geoservices

| Field | Value |
| --- | --- |
| Provider | Bundesamt für Landestopografie swisstopo |
| Geoservices entry point | <https://www.swisstopo.admin.ch/en/geoservices-with-swisstopo-geodata> |
| Digital maps | <https://www.swisstopo.admin.ch/en/digital-maps> |
| Map viewer (service documentation) | <https://map.geo.admin.ch/> |
| Historical series documentation (verified HTTP 200, 2026-10-18) | [Historische Kartenwerke](https://www.swisstopo.admin.ch/de/historische-kartenwerke) · [Digitale Siegfriedkarte](https://www.swisstopo.admin.ch/de/digitale-siegfriedkarte) · [Digitale Dufourkarte](https://www.swisstopo.admin.ch/de/digitale-dufourkarte) · [SWISSIMAGE HIST](https://www.swisstopo.admin.ch/de/orthobilder-swissimage-hist) · [SWISSIMAGE HIST 1946](https://www.swisstopo.admin.ch/de/orthobilder-swissimage-hist-1946) |
| WMTS capabilities used | `https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml` |
| WMTS tile template | `https://wmts.geo.admin.ch/1.0.0/<layerId>/default/<Time>/3857/<z>/<x>/<y>.<ext>` |
| Place search | `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=<q>&type=locations&sr=4326&limit=<n>` (CORS `*`) |
| Rights | Open Government Data / swisstopo geoservices terms — free use **with attribution** |
| Attribution | “© swisstopo” (Zeitreise layers: © swisstopo – Zeitreise, historische Kartenwerke) |

Layers exposed by the app (`public/data/overlays.json`, from the capabilities
document):

| Layer | Title | Editions (`Time` values) |
| --- | --- | --- |
| `ch.swisstopo.zeitreihen` | Zeitreise – Kartenwerke | 178 values, `YYYYMMDD` 18441231 … 20211231 (the service advertises 1844 but serves empty tiles before 1849; the app skips such editions after probing) |
| `ch.swisstopo.hiks-siegfried` | Siegfriedkarte 1:25 000 | 80 values, `YYYY` 1870 … 1949 |
| `ch.swisstopo.hiks-dufour` | Dufourkarte Erstausgabe | `current` |
| `ch.swisstopo.swissimage-product` | SWISSIMAGE Zeitreise (Luftbilder) | 100 values, `YYYY` 1926 … 2025 + `current` |
| `ch.swisstopo.swissimage-product_1946` | SWISSIMAGE 1946 | `1946` |
| `ch.swisstopo.pixelkarte-farbe-pk25.noscale` | Landeskarte 1:25 000 | 76 |
| `ch.swisstopo.pixelkarte-farbe-pk50.noscale` | Landeskarte 1:50 000 | 90 |
| `…pk100/pk200/pk500/pk1000`, `…grau-pk1000` | Landeskarten 1:100 000 … 1:1 Mio. | 1 each |

Base map of the application: `ch.swisstopo.pixelkarte-farbe` (documented WMTS
template, `3857` matrix set), attribution shown on the map as `© swisstopo`.

Verification evidence:

```
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/18831231/3857/12/2145/1434.png
    -> 200 image/png, access-control-allow-origin: *
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.hiks-siegfried/default/1900/3857/12/2145/1434.png
    -> 200 image/png  (~153 kB, Zürich sheet)
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product_1946/default/1946/3857/12/2145/1434.jpeg
    -> 200 image/jpeg (~24 kB, Zürich aerial)
GET https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=Zürich&type=locations&sr=4326
    -> 200 application/json (label "Zürich (ZH)", lat/lon, geom_st_box2d)
```

Preview/thumbnail rule: every `overlay` record stores the tile URL the harvest
actually verified as non-empty (`thumbnailPlace` names the probe location, Zürich
first). Editions whose advertised tiles are empty at every probe location are left
out and listed in `records.json` `skipped` (e.g. Zeitreise 1844–1848).

Note: the `zoomlevel` attribute of some search results is a uint32 bitfield
(e.g. `4294967295`); the Worker drops implausible values instead of passing them on.

## 3. Local fixture provider

The committed registry contains only the two real providers above. Tests that need
synthetic records build them in memory (`tests/records.test.mjs`), so no fixture
metadata can appear in the public data or the UI.

## Fetching policy (politeness, caching, failure behaviour)

- **Bounded harvest**: `scripts/fetch-records.mjs` requests the documented OAI-PMH
  pages (32 `zuz` + 12 `landkarten` + 6 `cartesgeneve` + 6 `museecarto`, with
  resumption tokens), five SRU pages (five CQL searches, 100 records each),
  one IIIF manifest and one DOI landing page per candidate title, one
  `GetRecord` confirmation per SRU candidate, and the WMTS
  capabilities document, with a descriptive `User-Agent`
  (`Kartenzeit/1.0 (Canton-Zurich design study; contact: project maintainers)`).
  At most 3 concurrent requests with a short pause between them, and every
  upstream response (including tile probes) is cached under `.cache/fetch/`
  (git-ignored) so `--offline` reproduces the committed data without network
  access; a cold full refresh takes a few minutes, a warm one ~65 s, and the
  harvest is never part of the build.
- **Edge caches in the Worker**: `/api/search/places` 5 minutes,
  `/api/fetch` 1 hour, `/api/records|layers|sources` 5 minutes.
- **Timeouts**: 8 s per upstream call (`AbortSignal.timeout`), abortable client
  fetches in the place search.
- **Allowlist**: literal host + path prefixes only (`src/worker/allowlist.js`);
  everything else is `403 host_not_allowed`. No credentials anywhere.
- **Outage behaviour**: UI states are explicit — the place search falls back to
  local title suggestions and says so; map tiles, thumbnails and IIIF previews
  degrade to labelled placeholders with a link to the provider; the record list
  keeps working from the committed JSON.

## Dates — publication vs depiction

`yearStart`/`yearEnd` are the **publication** years from the imprint;
`depictedYearStart`/`depictedYearEnd` are the dates **shown on the map** and are
only filled when the upstream statement documents them, with the verbatim
evidence in `depictedSource` (27 of 109 records; the rest stay `null`, which the
detail panel labels “vom Anbieter nicht angegeben”). The filter uses publication
years, and the UI says so (“Zeitraum (Publikationsjahr)”), so the detail panel's
“Zeitraum dieses Blattes filtern” button also feeds the *publication* range — with
the Wildkarte sheets (published 1853, surveyed 1843–1851) a depicted-period filter
would hide the very sheet it came from. `scripts/validate.mjs` enforces the
invariants: depicted dates come in pairs, never postdate the imprint, and always
carry `depictedSource`.

## Endpoint verification (online)

`scripts/validate.mjs` and `npm test` are offline by design, so a refresh could
leave a dead link behind without any check noticing. `npm run verify:endpoints`
(`scripts/verify-endpoints.mjs`) is the online counterpart: it reads
`public/data/records.json` and `overlays.json`, collects every distinct URL they
promise (original record, library viewer, thumbnail, IIIF manifest, first-canvas
image service, WMTS preview tile), probes each one once with a descriptive
`User-Agent`, a 20 s timeout and 4 concurrent requests, prints a per-kind summary
and exits non-zero when anything stops answering 200 (`--json <file>` writes the
full report, `--offline` only lists the URLs, `--limit n` probes a prefix).

Last full run — **2026-10-19, 463 distinct URLs, 0 failures** on the 109-record
seed:

| Kind | Result |
| --- | --- |
| original record (DOI landing page / `map.geo.admin.ch` viewer) | 109/109 |
| thumbnail (IIIF `…/full/304/0/default.jpg` / WMTS tile) | 109/109 |
| library viewer (`…/content/zoom/<id>`) | 82/82 |
| IIIF manifest (`…/i3f/v20/<titleId>/manifest`) | 82/82 |
| IIIF image service (`…/info.json`) | 81/81 |

The script is deliberately *not* part of `npm run check`: the gate stays offline,
hermetic and fast, and this check needs the network.
