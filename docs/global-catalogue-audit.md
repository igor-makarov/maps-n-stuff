# Global historical map catalogue: source and georeferencing audit

Research date: **19 October 2026**. This is an integration investigation, not an
announcement that these collections have been imported. The running app still
has 221 catalogue entries, including 27 native georeferenced swisstopo
editions, and a separate registry of 12 swisstopo overlay layers. The other entries have scans, catalogue extents or approximate place
anchors; those do not establish a pixel-to-ground transformation.

## Recommendation

Build a catalogue from the original institutions, combining **native
georeferenced products** with **IIIF imagery plus reusable georeference
annotations**. Start with USGS HTMC and an Allmaps join across rights-cleared
institutional collections, then add NLS and Kartverket. This provides scale and
international coverage without treating OldMapsOnline's website as a bulk feed.
Retain the original holding institution, item link, credit and rights statement
on every result and overlay.

Assumption: the site should remain usable commercially. Noncommercial sources
are recorded separately pending a product decision. No provider is approved
wholesale: rights and an actual usable alignment must pass for each image or
sheet. Unknown rights remain pending; missing georeferencing enters a work queue.

## What “all sources” can currently mean

The [public OldMapsOnline partner directory](https://www.oldmapsonline.org/en/community/partners)
contains **50 entries**: 49 named entries and an unnamed link to the University
of Trier. Its advertised partner total elsewhere is 70+, so this public list
does not establish a complete inventory of every source in the current index.
The accompanying [machine-readable audit](../data/catalogue-source-audit.json)
tracks all 50 entries and distinguishes documented routes from unresolved ones.

The directory also repeats 172,587 for three unrelated institutions and links
the State Library of New South Wales to the Scottish library's website.
Reported directory counts are preserved for provenance, marked unverified, and
must not be summed into a promised catalogue size. The NSW institution is
tracked under its own official site. Trier's identity is inferred from the
directory link destination, not a supplied institution label.

Exact parity requires a current provider inventory and licensed catalogue/export
access from OldMapsOnline, followed by image and alignment rights checks. Its
[general terms](https://www.oldmapsonline.org/en/terms), particularly 4.2, 4.4,
4.6 and 4.7, do not grant a general right to redistribute the index or build a
commercial derivative service. The fact that the terms mention APIs does not
establish an open global API. An agreement could supply a complete inventory
and permitted feed; availability, price, redistribution and downstream image
rights would need to be established. No agreement or institutional outreach
has been initiated.

Georeferencer's [metadata export guidance](https://www.oldmapsonline.org/en/help/georeferencer/how-can-i-download-the-metadata)
and [bulk-download guidance](https://www.oldmapsonline.org/en/help/georeferencer/batch-download-of-georeferenced-maps)
describe individual downloads and requested bulk exports, potentially charged.
They do not constitute permission to mass-download the entire global service.
If a holding institution supplies a licensed export, use that rather than
extracting private endpoints or generating hundreds of thousands of individual
GeoTIFF downloads through the public UI.

## Strongest integration routes

| Source | Rights evidence | Genuine georeferencing | Remaining integration work |
| --- | --- | --- | --- |
| **USGS Historical Topographic Map Collection** | USGS-produced historical topographic maps are public domain. Keep third-party credit notices; do not extend this conclusion to every modern US Topo asset. | Native georeferenced GeoTIFF/GeoPDF products. The [programme page](https://www.usgs.gov/programs/national-geospatial-program/historical-topographic-maps-preserving-past) describes over 185,000 files from 1884–2006. | Harvest the official index with pagination; follow its file links; inspect source CRS and raster geotransform; build masked web tiles. The index polygon is a search footprint, not the image transform. |
| **Allmaps + original institutions** | Allmaps publishes its georeferencing data under CC0. This licenses annotations, **not the referenced scans**. | GCPs, image-space masks, transformation model and IIIF image identifiers. | Join each annotation to its institutional manifest/record and verified image rights. Preserve multiple maps per scan and canvas. Build an index and render with the Allmaps plugin or generate tiles. |
| **National Library of Scotland** | Documented CC BY 4.0 reuse for eligible map images, with collection exceptions. Metadata datasets have their own licences. | Georeferenced mosaics and individual WMTS links; some IIIF images can also join Allmaps. | Verify collection-specific terms and service/API traffic permission. Obtain a supported feed/export. Do not assume unlimited use of NLS-hosted tiles. Includes material outside Britain, such as Survey of India sheets. |
| **Kartverket** | Official free-product terms specify CC BY 4.0 and attribution; external layers may differ. | Historical county-map WMS and available GeoTIFF products; some scanned maps are still awaiting georeferencing. | Harvest the historical catalogue and capabilities; retain only aligned products. Confirm downloadable GeoTIFF availability per item; free JPEG access alone is insufficient. |
| **Leventhal / Boston Public Library** | Public-domain originals may be reused; the library does not assert extra scan restrictions. Partner-institution images require separate checks. | Documented Allmaps integration and Atlascope georeferencing. | Enumerate institutional JSON/IIIF records, join annotations, filter rights and retain credits. Do not apply the website/article footer's licence to all collection images. |
| **Harvard Map Collection** | Includes public-domain and restricted material; inspect each item and downloadable dataset licence. | Harvard Geospatial Library explicitly provides georeferenced scanned maps. | Harvest public geospatial records and verified download/service references; distinguish scans awaiting georeferencing from GIS-ready rasters. |
| **NYPL** | Use the rights/advisory of the particular image; selected public-domain releases exist. | Current Digital Collections code includes Allmaps integration. Legacy Map Warper is archived and stopped receiving updates in 2021. | Prefer present IIIF + Allmaps annotations; investigate a reusable archived warp export separately. Do not design against a presumed live legacy Warper API. |
| **SLUB Dresden** | Item licences vary: CC BY-SA 4.0 items are reusable with obligations; “free access, rights reserved” is not the same grant. | The Virtual Map Forum exposes a genuinely georeferenced subset and its software documents a georeferencing service. | Verify each map's rights and obtain stable documented tile/warp endpoints; catalogue membership alone does not qualify. |
| **Leiden, Utrecht, Dutch National Archives** | Manifest/item-level review. Dutch National Archives explicitly permits images with a download button and Public Domain/CC0 marking. | IIIF image routes documented in Allmaps' collection list; use actual matching annotations or obtain a provider export. | An IIIF manifest alone does not imply alignment. Establish metadata harvest permission and clear each scan. Utrecht's research-repository licence page does not establish a licence for its historical maps. |
| **Bern, ZB Zürich, ETH** | Existing e-rara item-level PDM evidence can be retained for the current records; other holdings require review. | Current e-rara catalogue bboxes do not georectify the scans. | Join actual annotations or georeference the images; expand the harvest beyond its current Swiss keyword/window/cap rules. |

Primary references:

- [USGS copyright FAQ](https://www.usgs.gov/faqs/are-usgs-topographic-maps-copyrighted),
  [HTMC programme and download formats](https://www.usgs.gov/programs/national-geospatial-program/historical-topographic-maps-preserving-past).
- [Allmaps open data](https://allmaps.org/),
  [IIIF Georeference Extension](https://iiif.io/api/extension/georef/),
  [Allmaps IIIF collection routes](https://github.com/allmaps/iiif-map-collections/blob/main/iiif-map-collections.yml).
- [NLS copyright guide](https://www.nls.uk/tools-for-research/copyright/),
  [NLS dataset explaining map-image reuse and exceptions](https://data.nls.uk/data/map-spatial-data/living-with-machines-railspace-building/),
  [example NLS map with reuse and WMTS options](https://maps.nls.uk/view/188871162).
  The dedicated map copyright/API pages were robots-blocked during this audit;
  no service entitlement was inferred from them.
- [Kartverket terms](https://www.kartverket.no/api-og-data/vilkar-for-bruk),
  [historical maps](https://www.kartverket.no/om-kartverket/historie/historiske-kart),
  [historical WMS catalogue](https://data.norge.no/nb/data-services/9df7ef15-51ad-3bc3-880e-7719f18b7593/historiske-kart-wms).
- [Leventhal permissions](https://www.leventhalmap.org/collections/permissions/),
  [Allmaps integration](https://www.leventhalmap.org/articles/new-features-for-georeferencing-in-lmec-collections/).
- [Harvard geospatial collection](https://library.harvard.edu/collections/geospatial-and-mapping-data),
  [Harvard guide to georeferenced maps](https://mapping.share.library.harvard.edu/tutorials/data-curation/accessing-maps-for-georeferencing/).
- [NYPL Warper status](https://www.nypl.org/digital-research/projects/map-warper),
  [NYPL Digital Collections releases](https://github.com/NYPL/digital-collections/releases).
- [SLUB map collection](https://www.slub-dresden.de/entdecken/karten),
  [SLUB reuse terms](https://nutzungshinweis.slub-dresden.de/),
  [SLUB service configuration](https://github.com/slub/slub_web_kartenforum).
- [Dutch National Archives image terms](https://www.nationaalarchief.nl/en/research/terms-of-use-for-scans-of-documents-maps-and-photos),
  [open archival metadata](https://www.nationaalarchief.nl/onderzoeken/open-data/archiefinventarissen-digitale-objecten-en-scans-van-archieven).

## Sources requiring restrictions or further evidence

[David Rumsey](https://www.davidrumsey.com/about/copyright-and-permissions) links
to **CC BY-NC-SA 3.0**, and
[Manchester](https://www.library.manchester.ac.uk/services/digitisation-services/copyright-and-licensing/index.htm)
states **CC BY-NC-SA 4.0** for its digital collections. These are conditional
noncommercial routes, not default commercial integrations. Images without the
relevant grant, including Rumsey images without a download option, require
separate consideration. A distinct permissive grant for an individual image can
be recorded if substantiated.

[Wisconsin Historical Society](https://www.wisconsinhistory.org/research/explore-our-collections/collection-overviews/maps-atlases/)
requires permission for republication under its published site terms.
[Hong Kong Historic Maps](https://www.hkmaps.hk/) describes personal use and
refers some government maps to OGL: that is not evidence that every scan or its
tile service can be reused. Trace each original source. Great River Arts has no
verified open collection grant in this audit. None of these is enabled.

[Bordeaux's 1886 terms](https://1886.u-bordeaux-montaigne.fr/s/1886/page/reutilisation)
allow reuse of PDM-marked images, but also state database protection. Establish
a permitted metadata feed, and obtain/create reusable georeferencing.
[Vorarlberg records](https://pid.volare.vorarlberg.at/suche/?facets=&ofset=120&q=%22Sammlung%3A+Historische+Landkarten%22)
show CC BY 4.0 on some historical maps; rights are per object, and no bulk warp
export was verified. ICGC's current mapping-product CC BY terms must not be
blindly applied to all Cartoteca scans. The British Library, GeoPortOst,
regional archives and the remaining small collections need item/collection
rights plus export checks; membership in OldMapsOnline is not such evidence.

## Data access and rendering design

### 1. Harvest original feeds outside the Worker request path

Use resumable offline/GitHub jobs for OAI-PMH, SRU, IIIF collections,
institutional search JSON and supported geospatial APIs. Respect pagination,
rate limits, published bulk policy, conditional requests and provider IDs.
Keep dated raw responses and checksums privately until metadata redistribution
is cleared. Public-domain image status does not by itself license the entire
institution's metadata database or hosted API capacity.

For the first two adapters:

- **Allmaps:** published bulk files are
  `https://files.allmaps.org/maps.ndjson`, `maps.json`, `annotations.json`,
  `maps.geojson` and `maps.geojsonl`. The homepage says they refresh twice a day.
  Stream NDJSON offline, retain the annotation ID/version and resolve the
  original IIIF manifest/image identifier. GeoJSON footprints help search;
  retain GCPs, masks and the transformation for rendering. If manifest links are
  absent in an export, resolve them through the documented Allmaps image or
  manifest routes instead of guessing institutional item IDs.
- **USGS:** discover products through topoView/The National Map. The indexed
  official layer
  `https://ngmdb.usgs.gov/arcgis/rest/services/topoview/ustOverlay/MapServer/0`
  is a candidate metadata route, with JSON/GeoJSON query support in its indexed
  documentation. Its live response and schema were not retrievable here.
  Verify current capabilities, fields, pagination and HTMC download links before
  implementing against it. Follow each provider-supplied GeoTIFF link; do not
  construct file paths from a title or bbox. Use only the historical products
  covered by the reviewed USGS rights evidence.

Allmaps bulk filenames and renderer behaviour were also checked against its
[source at a pinned revision](https://github.com/allmaps/allmaps/tree/a60fd5857d02881eb2e7f3cefdddbbfa46cecb7f):
`apps/homepage/src/components/DataTable.svelte`,
`packages/annotation/examples/map.example.json` and
`packages/maplibre/README.md`. The renderer is MIT. This source inspection
verifies the documented mechanism, not live reachability or current file counts.

### 2. Make rights decisions at image/sheet level

Keep separate evidence for **catalogue metadata**, **image reproduction**,
**georeferencing data** and **service/hosting use**. Store the authoritative
rights URL, verbatim statement, applicable licence/version, holder, credit,
retrieval date, evidence checksum and permitted operations: display, transform,
redistribute and commercial use. Account for the applicable territory when a
statement only describes US public-domain status. A PDM is a rights-status
mark, not a copyright licence; vague “no known restrictions” advisories require
review rather than automatic approval.

For an overlay pipeline, use verified PD/CC0, CC BY, CC BY-SA, applicable OGL
or another explicit compatible grant. Preserve attribution, licence links and
modification notices. Publish adapted CC BY-SA imagery under its required
licence. Keep NC items conditional; do not auto-publish an ND-licensed image
through a warping/derivative pipeline without a separate compatible grant.
Missing, contradictory or inherited website-footer rights remain pending.

### 3. Require a reproducible pixel-to-ground transformation

Accept one of:

1. **GeoTIFF/COG or GeoPDF:** inspect the actual raster with GDAL; retain CRS,
   geotransform/GCPs, nodata and provenance. A TIFF extension alone proves
   nothing. Reproject from its source datum, which may be NAD27 rather than
   WGS84; preserve any required grid-shift dependencies.
2. **Native WMS/WMTS/XYZ:** retain verified capabilities, layer/time/matrix-set
   identifiers, CRS and permitted service URLs. Validate matrix origin, axis
   order, coverage and real image pixels. An arbitrary XYZ link is not proof of
   correct alignment or reuse rights.
3. **IIIF georeference annotations:** validate the actual image dimensions,
   GCP pixel coordinates and ground longitude/latitude, clipping mask and
   selected transformation. Use enough independent, non-collinear points for
   that model; reject singular or implausible transforms. Preserve insets as
   separate georeferenced maps rather than stretching the whole page to one box.

For all routes, inspect alignment at identifiable landmarks and multiple zooms,
check antimeridian/polar handling, record residuals where available, and retain
a quality grade and reviewer/provenance. Low residuals alone do not establish
accuracy; historical drawings may have real distortions. Do not fabricate
control points from bounding-box corners. Maps with no meaningful geographic
alignment, such as some schematic views, cannot honestly become overlays.

### 4. Serve a spatial catalogue and warped imagery on Cloudflare

The current browser-side 221-record list and fixed overlay registry cannot
scale to these collections. Add a Worker viewport/year/text query over a
versioned spatial index (for example D1 coarse spatial cells plus exact bbox
checks; use multiple cells and split antimeridian footprints). Page results,
deduplicate by institution, source image/canvas and annotation identity, and
retain distinct editions and separate regions of the same scan. Report
discovered / rights-cleared / georeferenced / quality-reviewed / live counts
separately by provider and geography.

Store approved metadata, annotations and generated tile archives in R2. For
IIIF, an Allmaps MapLibre layer can warp the original image in the browser;
it needs working CORS and permission to use the institutional service.
Where allowed, pre-render tiles offline with a GDAL/Allmaps toolchain and serve
XYZ or raster PMTiles over R2 with range support. Do not perform large TIFF
downloads or GDAL warps inside a Worker request or the routine CF site build.
The collection imagery retains its own licence when hosted separately.

Replace/extend the custom map renderer with MapLibre + the Allmaps plugin for
GCP-based layers, while retaining native raster overlays. Add verified hosts
and paths to CSP/Worker allowlists per adapter; never introduce an unrestricted
image proxy. Keep archive overlays separate from the existing historical-border
snapshot dataset: map sheets and historical political boundaries are different
data products.

Cloudflare continues building/deploying the site from `main` using the existing
commands. Large catalogue harvests and tile generation produce separate,
versioned data artifacts. A failed harvest must leave the last good catalogue
available. Do not make CF deployment depend on hundreds of upstream services.

## Delivery order and completion criteria

1. Implement normalized record/sheet IDs, rights evidence and the real
   georeferencing contract. Add the spatial query and renderer using a few
   verified examples from different continents and multiple providers.
2. Import the rights-cleared Allmaps subset for international variety and the
   native USGS historical collection for scale. Publish actual post-gate counts
   and coverage; do not use an upstream marketing count as an imported count.
3. Add NLS, Kartverket, Leventhal, Harvard, NYPL, SLUB and the other IIIF
   candidates through provider adapters. Remove the existing Swiss geographic
   restrictions from a new global harvest rather than just increasing its caps.
4. Resolve the remaining registry entries: obtain published compatible rights
   and an authorized export, or record the exclusion reason. Obtain a complete
   inventory/licensed feed if exact OldMapsOnline parity remains the target.
5. Queue permitted scans without alignments for georeferencing and visual QA.
   Keep them out of the overlay-ready catalogue until complete.

A provider is integrated when its feed is reproducible and permitted, all
published images have attributable rights evidence, every advertised overlay
has a usable transformation and a live render check, dates are sourced, and
pagination, failure recovery and versioning work. This audit introduces no new
maps into production and does not claim that all 50 providers are cleared.

## All 50 public-directory entries

The table below is generated from the audit registry. “Candidate” means a
documented route for some material, not a grant for an entire collection.
“Review” means that compatible image rights and/or exportable alignment remain
unverified. See the JSON for the specific evidence and next action.

| # | Institution | Assessment | Georeferencing route |
| --- | --- | --- | --- |
| 1 | [National Library of Scotland, Maps of Scotland](https://maps.nls.uk/) | Candidate subset | Native service documented |
| 2 | [USGS Historical Topographic Maps](https://ngmdb.usgs.gov/) | Candidate subset | Native raster documented |
| 3 | [Land Survey Office Czech Republic](https://cuzk.cz/) | Review | No reusable transform verified |
| 4 | [The David Rumsey Map Collection](https://www.davidrumsey.com/) | Noncommercial conditional | Alignment/export review |
| 5 | [Charles University in Prague, The Map Collection](https://natur.cuni.cz/) | Review | Alignment/export review |
| 6 | [Kartverket](https://kartverket.no/) | Candidate subset | Native service documented |
| 7 | [New York Public Library, Map Divison](https://digitalcollections.nypl.org/) | Candidate subset | Match actual IIIF annotations |
| 8 | [Leiden University](https://www.universiteitleiden.nl/) | Review | Match actual IIIF annotations |
| 9 | [Saxon State and University Library Dresden (SLUB)](https://www.slub-dresden.de/) | Candidate subset | Native service documented |
| 10 | [University Library of Bern](https://www.ub.unibe.ch/) | Candidate subset | Match actual IIIF annotations |
| 11 | [The British Library, Map Library](https://www.bl.uk/) | Review | Alignment/export review |
| 12 | [Moravian Library, Mollova mapová sbírka](https://mzk.cz/) | Review | Alignment/export review |
| 13 | [Národní technické muzeum](https://www.ntm.cz/) | Review | No reusable transform verified |
| 14 | [GeoPortOst](https://geoportost.ios-regensburg.de/) | Review | Alignment/export review |
| 15 | [Zentralbibliothek Zürich](https://www.zb.uzh.ch/) | Candidate subset | Match actual IIIF annotations |
| 16 | [Muzeum Brněnska](https://www.muzeumbrnenska.cz/) | Review | No reusable transform verified |
| 17 | [Utrecht University Library, Special Collections](https://www.uu.nl/) | Review | Match actual IIIF annotations |
| 18 | [Royal Library of Belgium map collection](https://www.kbr.be/) | Review | No reusable transform verified |
| 19 | [Harvard Library, Harvard Map Collection](https://library.harvard.edu/) | Candidate subset | Native raster documented |
| 20 | [Státní oblastní archiv v Třeboni](https://www.ceskearchivy.cz/) | Review | No reusable transform verified |
| 21 | [Státní oblastní archiv v Zámrsku](https://vychodoceskearchivy.cz/) | Review | No reusable transform verified |
| 22 | [ETH-Bibliothek Map Collection](https://library.ethz.ch/) | Candidate subset | Match actual IIIF annotations |
| 23 | [Historický ústav Akademie věd České Republiky](https://www.hiu.cas.cz/) | Review | No reusable transform verified |
| 24 | [Státní oblastní archiv v Plzni](https://www.soaplzen.cz/) | Review | No reusable transform verified |
| 25 | [Norman B. Leventhal Map Center at the Boston Public Library](https://www.leventhalmap.org/) | Candidate subset | Match actual IIIF annotations |
| 26 | [State Library New South Wales](https://www.sl.nsw.gov.au/) | Review | No reusable transform verified |
| 27 | [Bordeaux Montaigne University](https://www.u-bordeaux-montaigne.fr/) | Candidate subset | Alignment/export review |
| 28 | [Institut Cartogràfic i Geològic de Catalunya](https://www.icgc.cat/) | Review | Match actual IIIF annotations |
| 29 | [Dutch National Archives](https://www.nationaalarchief.nl/) | Candidate subset | Match actual IIIF annotations |
| 30 | [Technische Universität Darmstadt, University and State Library (ULB)](https://www.ulb.tu-darmstadt.de/) | Review | Alignment/export review |
| 31 | [Univerzita Jana Evangelisty Purkyně v Ústí nad Labem](https://www.ujep.cz/) | Review | No reusable transform verified |
| 32 | [Masarykova univerzita](https://www.muni.cz/) | Review | No reusable transform verified |
| 33 | [Městská knihovna v Praze](https://www.mlp.cz/) | Review | No reusable transform verified |
| 34 | [Vorarlberger Landesrepositorium](https://pid.volare.vorarlberg.at/) | Candidate subset | No reusable transform verified |
| 35 | [University of Manchester Map Library](https://www.library.manchester.ac.uk/) | Noncommercial conditional | Alignment/export review |
| 36 | [Art Research Center, Ritsumeikan University](https://en.ritsumei.ac.jp/) | Review | Alignment/export review |
| 37 | [Wisconsin Historical Society](https://www.wisconsinhistory.org/) | Permission required | No reusable transform verified |
| 38 | [UCLA Library](https://www.library.ucla.edu/) | Review | No reusable transform verified |
| 39 | [Městské muzeum v Jaroměři](https://www.muzeumjaromer.cz/) | Review | No reusable transform verified |
| 40 | [Biblioteca Nacional de Colombia](https://www.bibliotecanacional.gov.co/) | Review | No reusable transform verified |
| 41 | [Národní technická knihovna](https://www.techlib.cz/) | Review | No reusable transform verified |
| 42 | [Západočeské muzeum v Plzni](https://www.zcm.cz/) | Review | No reusable transform verified |
| 43 | [Colonial Portuguese maps of Cape Verde, São Tomé and Príncipe, Angola, East Timor](https://gpixel.org/) | Review | No reusable transform verified |
| 44 | [Vědecká knihovna v Olomouci](https://www.vkol.cz/) | Review | No reusable transform verified |
| 45 | [North Carolina Digital Heritage Center](https://library.unc.edu/) | Review | No reusable transform verified |
| 46 | [Hong Kong Historic Maps](https://www.hkmaps.hk/) | Review | Alignment/export review |
| 47 | [Great River Arts](https://great-river-arts.myshopify.com/) | Review | No reusable transform verified |
| 48 | [University of Trier (unnamed directory entry)](https://www.uni-trier.de/) | Review | No reusable transform verified |
| 49 | [Výzkumný ústav geodetický, topografický a kartografický](https://www.vugtk.cz/) | Review | No reusable transform verified |
| 50 | [Staatsarchiv des Kantons Zürich](https://www.zh.ch/) | Review | No reusable transform verified |
