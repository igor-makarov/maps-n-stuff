# Final source status — 2026-10-20 12:25 UTC

Measured from the merged `main` catalogue, not from registry claims. Total:
**44,513 records from nine providers**, 8 shards plus a 7,536-record core.

| Provider | Records | Rights basis retained per record | Live verification |
| --- | ---: | --- | --- |
| Stanford (pinned CC0 catalogue) | 4,464 | Stanford/collection statements; 117 native COGs | baseline, 117 native overlays |
| e-rara (OAI `landkarten`, `cartesgeneve`, `museecarto` + seed) | 3,045 | explicit `PDM 1.0` (all) | manifests/thumbnails sampled 8–10 per slice, 200 JSON/JPEG |
| swisstopo | 27 | Swiss Open Government Data, attribution required | baseline |
| Leventhal / Boston Public Library | 10,242 | 10,231 no-known-restrictions, 11 CC BY 4.0 with manifest attribution | 30/30 thumbnails + 30/30 IIIF `info.json` |
| Digital Commonwealth partner holdings (7 named institutions) | 972 | 823 no-known-restrictions, 136 CC0, 13 NoC-US | 30/30 thumbnails + 30/30 `info.json` |
| Doria / National Library of Finland | 1,662 | 1,269 PDM, 365 CC0, 28 explicit plain-PD statements | 30/30 thumbnails, 30/30 originals/records |
| USGS Historical Topographic Maps (HTMC) | 23,945 | U.S. Public Domain (USGS-produced), USGS credit | 24/24 preview+GeoTIFF range reads over 3 slices; GeoTIFFs parsed by `geotiff.js` and the app's renderer |
| SLUB Dresden OAI `maps` | 105 | explicit PDM 1.0 only; 56 rights-reserved/CNE withheld | 24/24 originals + record pages (no thumbnail due to Anubis bot gate) |
| Library of Congress (Civil War Maps) | 51 | item-level Geography and Map Division free-use statement, no restricting Rights Advisory | 12/12 thumbnails, 11/12 `info.json`, 0/12 manifests (edge 403) |

**Georeferencing:** 24,062 records carry provider-supplied GeoTIFF/COG rasters
(117 Stanford + 23,945 USGS). No new alignment was invented for scans. USGS
product bounding boxes are documented footprints, not image transforms; the
GeoTIFF is the transform source. 36,557 records state an extent and 44,407 have a
preview; 40,080 can be drawn on the map from a stated extent or point.

**Newly usable original collections this run:** e-rara depth (2,859 additional
PDM maps), Doria/NLF (1,662), Digital Commonwealth partner holdings (972, one
consortium service with seven named holders), USGS HTMC (23,945), SLUB Dresden
(105), LoC Civil War Maps (43 additional records over the 8 baseline). e-rara
`landkarten`, `cartesgeneve` and `museecarto` are complete for their documented
OAI sets; the remaining 0 eligible head ids are recorded in the selection.

**Examples (stable ids):** `e-rara:25915291` “Géographie du Moyen Age:
[Mappemonde d'Istakri]” (Bibliothèque de Genève, 1852, PDM);
`doria:84494` “[Mundus]” (National Library of Finland);
`leventhal:commonwealth:5712tb01h`; `usgs:5a8a27e9e4b00f54eb3c4854`
(Morristown, TN 1883, provider GeoTIFF); `slub:285992066` (Schreiber atlas,
Leipzig 1730, PDM); `loc:2009581125` (American Civil War maps, 1910).

**Verification on the merged tree:** `npm run check` → build/asset validation
(44,513 records, 7,536 core + 8 shards, 9 providers, 122 overlays), **285/285**
unit tests and Worker dry-run pass. `scripts/browser-global-check.mjs` against
`wrangler dev` → **50/50** checks at desktop, 390 px and 320 px, including
history and the native raster renderer (`/tmp/shots-iter7/report.json`). The
browser harness mocks external hosts; provider access was verified separately by
the live samples above.

**Open blockers (not coverage):**
- **LoC**: item endpoint still returns a Cloudflare 429 challenge after ~15
  polite requests; 483 candidates wait for a cooldown, cursor replays page 1.
  IIIF manifests return 403 at the edge; `tile.loc.gov` pixels are reachable.
- **Gallica/BnF** and **NLS**: 403/405 access challenges from this runner.
- **NDL Japan**: documented discovery endpoints answer 429; manifests alone are
  not coverage.
- **MDZ**: IIIF manifests work, but no documented OAI/search discovery route was
  found.
- **Princeton Figgy**: NKC/NoC metadata exists, but image and metadata
  redistribution permission (and the `NKC` advisory's meaning) remain unresolved.
- **SLUB Kartenforum / Deutsche Fotothek**: no per-record licence in the public
  index; research-only.
- **Doria metadata reuse**: image rights are PDM/CC0/plain-PD, but no separate
  metadata-reuse licence was found; recorded as `unresolved-pending`.
- **USGS**: only a fraction of the 186,061 advertised products is bundled; depth
  is limited by shard size/client startup, not by a claim that the rest is
  unusable.

## Addendum by member 0 — metadata-reuse decision (observed 2026-10-20T12:18Z)

Observed runner time when this addendum was written: **12:18 UTC** (`date -u`).
The heading's "12:25 UTC" was not a measured publication time; this addendum
does not change the provider counts or the live results above, which remain the
merged-tree evidence measured by member 1.

**The `unresolved-pending` metadata status is closed.** The decision and its
primary quotes are in
`coordination/metadata-rights-decision-20261020.md`; `public/data/sources.json`
now records `status: "basis-recorded"` (never "cleared by a licence") for:

- **Doria / National Library of Finland** — per-item MODS `useAndReproduction`
  CC0 1.0 / Public Domain condition retained on every admitted record; factual
  description published through the documented OAI-PMH interface; no separate
  metadata licence is published and none is claimed. The empty
  `https://www.doria.fi/page/terms` body is recorded as the evidence that no
  additional terms can be cited, not as a licence.
- **Digital Commonwealth / BPL / Leventhal and the seven partner institutions** —
  factual catalogue descriptions published through the documented API, whose
  page states that metadata content may be used "in other applications and data
  services"; the copyright page places no restrictions on public-domain
  material while each item's own statement remains the image gate; no separate
  metadata licence is published or claimed.
- **SLUB Dresden** — factual description published with each explicit PDM 1.0
  object; the SLUB Nutzungsbestimmungen permit copying, modification,
  distribution and performance of PDM objects, including commercially, with the
  required citation; the 56 rights-reserved/CNE objects stay withheld.

This is a recorded basis with explicit limits, not a licence upgrade: image
admission, verbatim rights wording and attribution are unchanged, and a future
institution statement restricting catalogue data would require withholding the
affected records. The previous Doria row wording is superseded only in respect of
the metadata status; its rights counts and 30/30 live checks stand as written.
