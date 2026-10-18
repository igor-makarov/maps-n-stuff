# Data sources — registry, rights and verification evidence

Machine-readable registry: [`public/data/sources.json`](../public/data/sources.json)
(providers, endpoints actually used, rights, attribution, retrieval date) and
[`public/data/overlays.json`](../public/data/overlays.json) (georeferenced map
layers). Refresh script: [`scripts/harvest-seed.mjs`](../scripts/harvest-seed.mjs).
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
| Metadata endpoint | `https://www.e-rara.ch/zuz/oai?verb=ListRecords&metadataPrefix=oai_dc&set=zuz` (OAI-PMH 2.0, `oai_dc`) |
| IIIF manifest (Presentation API 2.0) | `https://www.e-rara.ch/i3f/v20/<titleId>/manifest` |
| IIIF image service (Image API 2, level 2) | `https://www.e-rara.ch/i3f/v20/<imageId>/full/<size>/0/default.jpg` |
| Holding institution | Zentralbibliothek Zürich (also ETH-Bibliothek Zürich for other sets) |
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
| `title`, `titleAlt`, `creators`, `publisher`, `languages` | `oai_dc` (`dc:title`, `dc:creator`, `dc:publisher`, `dc:language`) |
| `yearStart`/`yearEnd` | publication year parsed from the imprint date (`dc:date`) |
| `depictedYearStart`/`depictedYearEnd` | only when the record itself states a survey/map date; otherwise `null` (never derived from the publication year) |
| `institution`, `shelfmark`, `extent`, `extentStatement`, `canvasCount`, `imprint` | IIIF manifest `metadata` + `sequences[0].canvases` |
| `thumbnail` | IIIF thumbnail/derivative (`…/full/304/0/default.jpg`) |
| `rights` | verbatim `dc:rights` |
| `geo` / `geoNote` | only from a stated place/bbox; the seed derives one point from a swisstopo search hit and labels it as such |

## 2. swisstopo — Federal Office of Topography geoservices

| Field | Value |
| --- | --- |
| Provider | Bundesamt für Landestopografie swisstopo |
| Geoservices entry point | <https://www.swisstopo.admin.ch/en/geoservices-with-swisstopo-geodata> |
| Digital maps | <https://www.swisstopo.admin.ch/en/digital-maps> |
| Map viewer (service documentation) | <https://map.geo.admin.ch/> |
| WMTS capabilities used | `https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml` |
| WMTS tile template | `https://wmts.geo.admin.ch/1.0.0/<layerId>/default/<Time>/3857/<z>/<x>/<y>.<ext>` |
| Place search | `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=<q>&type=locations&sr=4326&limit=<n>` (CORS `*`) |
| Rights | Open Government Data / swisstopo geoservices terms — free use **with attribution** |
| Attribution | “© swisstopo” (Zeitreise layers: © swisstopo – Zeitreise, historische Kartenwerke) |

Layers exposed by the app (`public/data/overlays.json`, from the capabilities
document):

| Layer | Title | Editions (`Time` values) |
| --- | --- | --- |
| `ch.swisstopo.zeitreihen` | Zeitreise – Kartenwerke | 178 values, `YYYYMMDD` 18441231 … 20211231 |
| `ch.swisstopo.hiks-dufour` | Dufourkarte Erstausgabe | `current` |
| `ch.swisstopo.pixelkarte-farbe-pk25.noscale` | Landeskarte 1:25 000 | 76 |
| `ch.swisstopo.pixelkarte-farbe-pk50.noscale` | Landeskarte 1:50 000 | 90 |
| `…pk100/pk200/pk500/pk1000`, `…grau-pk1000` | Landeskarten 1:100 000 … 1:1 Mio. | 1 each |

Base map of the application: `ch.swisstopo.pixelkarte-farbe` (documented WMTS
template, `3857` matrix set), attribution shown on the map as `© swisstopo`.

Verification evidence:

```
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/18441231/3857/12/2144/1434.png
    -> 200 image/png, access-control-allow-origin: *
GET https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=Zürich&type=locations&sr=4326
    -> 200 application/json (label "Zürich (ZH)", lat/lon, geom_st_box2d)
```

Note: the `zoomlevel` attribute of some search results is a uint32 bitfield
(e.g. `4294967295`); the Worker drops implausible values instead of passing them on.

## 3. Local fixture provider (`local`)

`sources.json` keeps a `local` entry for test fixtures. **No seed record uses
it**, no fixture metadata is presented as real data, and `npm test` asserts the
distinction (see `tests/data.test.mjs`).

## Fetching policy (politeness, caching, failure behaviour)

- **Bounded harvest**: `scripts/harvest-seed.mjs` requests 3 OAI-PMH pages /
  ≤ 24 titles per run, with a descriptive `User-Agent`
  (`maps-n-stuff-seed-harvest/0.1 (+repository URL)`), and caches every upstream
  response under `.cache/` (git-ignored) so re-runs are cheap and `--offline`
  reproduces the committed data without network access.
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
