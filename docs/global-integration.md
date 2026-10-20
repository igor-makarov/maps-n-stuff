# Global collections and georeferencing

Implemented 19 October 2026. This supersedes the Swiss defaults in the earlier
development logs and implements the recommendations in the Swiss/language audit.

## What is available

The bundle contains 17,178 maps: 4,464 Stanford, 10,242 Leventhal/Boston Public
Library, 972 Digital Commonwealth partner-held, 1,437 e-rara, 27 swisstopo and
36 Library of Congress records.
Stanford contributes worldwide holdings, including Africa, Asia, Europe and the
Americas. There are 304 undated Stanford maps; dates, thumbnails, extents and
alignment are optional. Image reuse rights are not.

The importer reads all 27,783 metadata files at Stanford's institutional
OpenGeoMetadata revision `ff804e306fb2f79ac837c5045c7e0d9acb1d979b`.
The repository metadata licence is CC0. An item additionally needs public
access, map resource class, an explicit PDM/CC0 image licence, a rights statement,
and its original source identity. Conflicting restrictions reject the record.
Each item retains its exact rights statement and a pinned metadata-source URL.
No Stanford geography, decade, bounding-box or record-count quota is applied.

`npm run harvest` reproduces the import. It downloads the pinned metadata
repository; `--offline` reuses the checkout. The legacy regional harvester now
preserves unrelated global records. The 50-provider research registry remains
a research list: neither these imports nor its presence establish permission
to copy the entire OldMapsOnline index.

## Image alignment

117 Stanford records expose provider-supplied Cloud Optimized GeoTIFF files.
The raster viewer uses their GeoKeys, source coordinate reference system,
tiepoints or affine matrix, and raster resolution. It inverse-projects the
current Web Mercator viewport into source pixels, reads a bounded raster window
and paints it as an opacity-controlled overlay. Native overviews, pixel-centre
conventions and rotated affine transforms are handled. Unsupported/incomplete
CRSs report an error and leave the original scan/download available.

The Worker supplies bounded byte ranges from Stanford's original `_cog.tif`
URLs. It checks both upstream range headers and actual byte counts; it does not
download a huge full-resolution file when a source ignores Range requests.
Catalogue boxes are search footprints, never image transforms.

Other IIIF scans offer **Find reusable alignment** and **Georeference in Allmaps**.
Allmaps lookup verifies source-image identity, dimensions, mask, at least three
non-collinear control points and valid coordinates before offering a community
overlay. The annotation data is CC0; the original institution's image rights
still govern the image. The external editor supports creating alignment data;
return to the app and repeat lookup after publication. No automatic ML-based
georeferencing job or guaranteed alignment accuracy is claimed.

## Original collection searches

**Search more original collections** queries institutional JSON APIs, rather
than scraping the aggregator. It offers Library of Congress, Leventhal Map &
Education Center and USGS Historical Topographic Maps. Each request is bounded
to 12 results with pagination and caching. The first two require item-level
compatible rights evidence; unknown, noncommercial and conflicting statements
are withheld. USGS requests are confined to its public-domain historical-map
dataset. USGS searches the current map area; its results are displayed without
applying a potentially unrelated catalogue keyword.

Fetched maps are added to the current browser session and can be viewed through
the usual filters and source links. Live results are not a durable catalogue
import, and their shared selection links do not survive a new session until
the same source results have been loaded. A short-lived edge cache enables
alignment lookup for those fetched records. Service failure reports an English
notice and preserves the bundled catalogue.

Direct collection, image and Allmaps endpoints are blocked by this development
environment's network policy. Live API shapes and image availability therefore
still need verification from the deployed environment. Offline adapter fixtures
test admission and failure handling; synthetic raster tests verify the actual
renderer without pretending to verify Stanford's live imagery.

## Global reference layers, English and identity

Reference choices are worldwide OpenStreetMap and NASA Blue Marble Next
Generation, a cloud-free MODIS composite from August 2004 at approximately
500 m resolution. NASA credit and the resolution limit are visible. This is an
overview satellite image; close zooms enlarge the source pixels. Source:
<https://github.com/nasa-gibs/worldview/blob/main/config/default/common/config/metadata/layers/reference/blue_marble/BlueMarble_NextGeneration.md>.

The three Swiss reference choices, seven modern Swiss national-map overlays,
Swiss-only map shortcuts and Swiss place-search fallback are removed. Five
historical/aerial Swiss services remain as normal regional holdings. UI copy,
generated map titles, collection labels, dates and parser errors are English;
original historic titles, institutional names and verbatim rights retain their
source language. Original collection labels remain searchable as aliases.

Package, Wrangler and new Shurik member identities match `maps-n-stuff`.
Legacy stopped Shurik control branches are preserved, and the stop workflow
recognizes both names. No loop is resumed by this change.

Cloudflare builds from `main` using `npm run build` and deploys with
`npx wrangler deploy`. Its connected Worker must match `maps-n-stuff`; move
the existing build connection and custom domain if they still target the old
`zurich-maps` Worker. No Cloudflare account credentials are available here,
so an account-side migration has not been performed or claimed.
