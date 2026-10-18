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
| Metadata endpoint | `https://www.e-rara.ch/oai?verb=ListRecords&metadataPrefix=oai_dc&set=<setSpec>` (OAI-PMH 2.0, `oai_dc`; sets used: `zuz`, `landkarten`, `cartesgeneve` — `ListSets` is paginated, 105 sets in 11 pages) |
| IIIF manifest (Presentation API 2.0) | `https://www.e-rara.ch/i3f/v20/<titleId>/manifest` |
| IIIF image service (Image API 2, level 2) | `https://www.e-rara.ch/i3f/v20/<imageId>/full/<size>/0/default.jpg` |
| Holding institution | per record from the manifest `Besitzende Institution` — in the seed: Zentralbibliothek Zürich (20), ETH-Bibliothek Zürich (18), Bibliothèque de Genève (1) |
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
| `depictedYearStart`/`depictedYearEnd` | only when the record itself states a survey/map date; otherwise `null` (never derived from the publication year) |
| `institution` | manifest `Besitzende Institution` (first institution before the comma) |
| `recordUrl` | the DOI landing page (`https://www.e-rara.ch/doi/10.3931/e-rara-<id>`) |
| `thumbnail` | IIIF thumbnail from the manifest (`…/full/304/0/default.jpg`) |
| `imageService` | IIIF Image API 2 service id of the first canvas |
| `rights` | verbatim `dc:rights` (the seed set is `PDM 1.0`) |
| `extent` / `geo` | parsed from the manifest `Kartendaten` statement; `geo` is the centre of that stated bbox, never a guessed point |
| `imprint`, `collection`, `sheet` | manifest `Impressum`; the OAI set / sheet name from the manifest label |
| `imageService` | IIIF Image API 2 service id of the first canvas |
| `canvasCount` | number of canvases in the manifest (`sequences[0].canvases.length`) — 38 of 39 records state it, four are real multi-sheet works (2–3 sheets) |
| `viewerUrl` | the library's own deep-zoom viewer: the DOI landing page states the holding corpus in `og:url` (`http://www.e-rara.ch/<corpus>/<id>`); the harvest keeps only the corpus after checking `<id>` against the manifest title id and stores `https://www.e-rara.ch/<corpus>/content/zoom/<id>`. Corpora in the seed: `zuz` 20, `zut` 18, `gep_r` 1. Nothing is constructed when the landing page does not state it |

Selection rule (no hand-picked titles): every map record of an OAI set that is
not a series volume, oldest first, with a cap per set (ZB Wildkarte 20 sheets,
`landkarten` 18, `cartesgeneve` 1). A record is kept only when the manifest
states a `Kartendaten` bbox and an upstream year; duplicates of the same work are
dropped by leading title. The per-set numbers (`considered`/`kept`/`rule`) are
written into `records.json.selection`.

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
  pages (22 `zuz` + 10 `landkarten` + 4 `cartesgeneve`, with resumption tokens),
  one IIIF manifest and one DOI landing page per candidate title, and the WMTS
  capabilities document, with a descriptive `User-Agent`
  (`Kartenzeit/1.0 (Canton-Zurich design study; contact: project maintainers)`).
  At most 3 concurrent requests with a short pause between them, and every
  upstream response (including tile probes) is cached under `.cache/fetch/`
  (git-ignored) so `--offline` reproduces the committed data without network
  access; a warm full refresh takes ~50 s and is never part of the build.
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
only filled when the upstream statement documents them (in the current seed set
they are mostly `null`, which the detail panel labels “vom Anbieter nicht
angegeben”). The filter uses publication years, and the UI says so
(“Zeitraum (Publikationsjahr)”).
