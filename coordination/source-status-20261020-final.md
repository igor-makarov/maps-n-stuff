# Final source status — 2026-10-20 12:15 UTC

**Measured from the merged `main` catalogue at the runner clock (`date -u` =
2026-10-20 12:15 UTC), not from registry claims. Total: 31,637 records from six
bundled providers**, a 7,536-record core plus five shards. Provider entries in
`public/data/sources.json`: 9, of which 6 are bundled and 3 are withheld
research scopes.

| Bundled provider | Records | Rights basis retained per record | Live verification |
| --- | ---: | --- | --- |
| USGS Historical Topographic Maps (HTMC) | 23,945 | U.S. Public Domain (USGS-produced), USGS credit | 24/24 preview + GeoTIFF range reads over 3 slices; 5 sampled TIFFs parsed with GeoKeys/affine; app renderer exercised |
| Stanford (pinned CC0 catalogue) | 4,464 | Stanford/collection statements; 117 native COGs | baseline; 117 native overlays |
| e-rara (OAI `landkarten`, `cartesgeneve`, `museecarto` + seed) | 3,045 | explicit `PDM 1.0` (all) | manifests/thumbnails sampled 5–10 per slice, 200 JSON/JPEG; live 5/5 this iteration |
| SLUB Dresden OAI `maps` | 105 | explicit PDM 1.0 only; 56 rights-reserved/CNE withheld | 24/24 originals + record pages; no thumbnail due to Anubis browser gate |
| Library of Congress (Civil War Maps + general maps) | 51 | item-level Geography and Map Division free-use statement, no restricting Rights Advisory | full 51-record pass 2026-10-20: 43/43 kept image services answered 206 JSON/JPEG; 8 dead services withheld with `imageNote`; 0/51 manifests (edge 403) |
| swisstopo | 27 | Swiss Open Government Data, attribution required | baseline; live 5/5 thumbnails |

**Withheld research scopes (not shipped, not counted above).** Full records and
evidence are in `research/withheld/`, outside `public/`; their provider entries
carry `bundled:false`. Images and **metadata** rights are separate decisions.

| Withheld scope | Records | Image rights (retained) | Reason withheld |
| --- | ---: | --- | --- |
| Leventhal / Boston Public Library | 10,242 | 10,231 no-known-restrictions, 11 CC BY 4.0 with credit | no primary metadata-reuse licence; Digital Commonwealth copyright/API pages document item/image terms and machine access only |
| Doria / National Library of Finland | 1,662 | 1,269 PDM, 365 CC0, 28 plain-PD statements | Doria terms page static body empty; no repository metadata licence found |
| Digital Commonwealth partner holdings (7 named institutions) | 972 | 823 no-known-restrictions, 136 CC0, 13 NoC-US | same shared service/terms as the BPL scope; no per-institution metadata grant |

**Georeferencing:** 24,062 shipped records carry provider-supplied GeoTIFF/COG
raster links (117 Stanford + 23,945 USGS). No alignment was invented for scans.
USGS product bounding boxes are documented footprints, not image transforms; the
GeoTIFF is the transform source. 30,352 shipped records state an extent, 31,628
have a preview image link (8 LoC records keep only the record/viewer because
their advertised derivative was dead) and 30,358 can be drawn from a stated
extent or point. The 117 Stanford COGs + five regional layers remain the fixed
overlay index; USGS is opened from its record-level georeferencing.

**Newly usable original collections this run (kept):** e-rara depth (2,859
additional PDM maps), USGS HTMC (23,945), SLUB Dresden (105), LoC Civil War Maps
(43 additional records over the 8 baseline). e-rara `landkarten`,
`cartesgeneve` and `museecarto` are complete for their documented OAI sets.
Doria, Leventhal/BPL and Digital Commonwealth partner holdings were harvested and
image-verified, but are withheld as above rather than claimed as coverage.

**Examples (stable ids):** `e-rara:25915291` “Géographie du Moyen Age:
[Mappemonde d'Istakri]” (Bibliothèque de Genève, 1852, PDM);
`usgs:5a8a27e9e4b00f54eb3c4854` (Morristown, TN 1883, provider GeoTIFF);
`slub:285992066` (Schreiber atlas, Leipzig 1730, PDM); `loc:2009581125`
(American Civil War maps, 1910); `loc:00561384` (Mexico City, record/viewer kept;
dead image service withheld). Withheld sample records: `doria:84494`,
`leventhal:commonwealth:3f462s124`, `digitalcommonwealth:commonwealth:z890vr23m`.

**Verification on the merged tree:** `node scripts/validate.mjs` → 31,637
records (7,536 core + 5 shards), 9 provider entries (6 bundled), 122 overlays,
54 history snapshots. `npm test` → **286/286 pass**. `npm run build` → asset
validation. Browser harness `scripts/browser-global-check.mjs` against local
`wrangler dev` → **50/50** checks at desktop, 390 px and 320 px, including
history and the native raster renderer. The harness mocks/blocks external hosts;
the live samples above are separate. `wrangler deploy --dry-run` is a packaging
check, not a Cloudflare deployment proof.

**Open blockers (not coverage):**
- **Metadata reuse**: the three withheld scopes need a primary licence or other
  substantiated redistribution basis before restoration; see
  `research/withheld/README.md`.
- **LoC**: item endpoint intermittently returns a Cloudflare challenge; 483
  candidates wait for a cooldown, cursor replays page 1. IIIF manifests return
  403 at the edge; `tile.loc.gov` pixels are reachable independently. Eight dead
  general-map image services were removed.
- **Gallica/BnF** and **NLS**: 403/405 access challenges from this runner.
- **NDL Japan**: documented discovery endpoints answer 429; manifests alone are
  not coverage.
- **MDZ**: IIIF manifests work, but no documented OAI/search discovery route was
  found.
- **Princeton Figgy**: NKC/NoC metadata exists, but image and metadata
  redistribution permission remain unresolved.
- **SLUB Kartenforum / Deutsche Fotothek**: no per-record licence in the public
  index; research-only.
- **USGS**: only 23,945 of the 186,061 advertised products are bundled; depth is
  limited by shard size/client startup, not by a claim that the rest is
  unusable. GeoPDF-only products are not yet revisited.

## Addendum by member 0 — metadata-reuse evidence after the withholding (observed 2026-10-20T12:26Z)

Observed runner time: **12:26 UTC** (`date -u`). This addendum does not change
the counts, provider list or live results above; it records additional primary
evidence gathered by member 0 after the 12:15 UTC status was measured, and it
confirms that the three withheld scopes stay withheld.

- The API/copyright pages and the per-item Doria MODS condition were fetched and
  quoted in `coordination/metadata-rights-decision-20261020.md`. The quotes
  establish machine access, item/image rights and a PDM/CC0 condition for
  admitted Doria objects. They do **not** amount to a repository-wide metadata
  redistribution licence: the Digital Commonwealth API sentence documents
  machine access, the copyright page declines to grant or deny publication
  permission, and Doria's terms page remains an empty template. No scope is
  restored by this evidence.
- `public/data/sources.json` now links that note from the three
  `metadataReuse.status = "withheld"` entries and keeps the full records under
  `research/withheld/`; no served asset was re-added.
- SLUB is the one scope whose primary terms explicitly license the PDM objects
  with a citation; its entry now records the structured `basis-recorded`
  evidence. Its 105 records and rights counts are unchanged.
- **SLUB's Kartenforum/Deutsche Fotothek scope remains research-only** (no
  per-record rights in the public index). LoC's 8 dead image services stay
  withheld; its item endpoint remains intermittent at the edge. USGS is still a
  partial 23,945-record import of 186,061 advertised products, and GeoPDF-only
  products are not revisited in this iteration.

## Addendum by member 0 — USGS GeoPDF-only repair (observed 2026-10-20T12:41Z)

Observed runner time: **12:41 UTC** (`date -u`). This addendum supersedes the
USGS row and the USGS bullet above only where they say 23,945 records and
"GeoPDF-only products are not yet revisited". It does not rewrite another
member's measurements; the earlier text remains historical evidence.

- The shipped catalogue is now **31,692 records** (7,536 core + 5 shards).
  USGS is **24,000**: the same first 24,000 TNM products (offsets 0–23999),
  with **55 previously withheld GeoPDF-only products now admitted**. The
  other 23,945 keep their provider-supplied GeoTIFF and `kind: cog`; the 55
  have no `georeference` object, no `kind: cog` and no synthesized transform.
  They retain the supplied original GeoPDF, preview, extent and public-domain
  policy. Example: `usgs:67dcc82dd34eae450ac1c650` (Magazine Mountain, AR
  1887). This is a bounded repair of the existing prefix, not a new harvest;
  `records.json.selection["usgs:htmc"].withheld` is now empty and the
  resumable cursor remains 24000. Shard `usgs.json` is 19.29 MiB / 12,002
  records; `usgs-2.json` 6,000 and `usgs-3.json` 5,998.
- The replay merge was repaired so an already-imported prefix adds only the
  previously withheld products to the target shard instead of copying all
  24,000 records into it (which had raised the 24 MiB asset guard). Existing
  records in other shards are preserved in place.
- Live range verification on the repaired slice: 8/8 previews 206
  `image/jpeg`; seven sampled GeoTIFFs 206 `image/tiff` with TIFF magic,
  parsed and projected by the browser renderer; the sampled GeoPDF-only record
  206 with `%PDF` magic. `node scripts/validate.mjs` → 31,692 records,
  9 providers (6 bundled), 122 overlays, 54 history snapshots. `npm test` →
  **287/287 pass** (the new regression covers GeoPDF-only admission, no
  invented raster, and a mixed GeoTIFF/GeoPDF shard).
- Georeferencing count is unchanged at 24,062 provider-supplied rasters
  (117 Stanford + 23,945 USGS); the 55 new records are explicitly unaligned.
- Still open: the remaining USGS feed beyond offset 24000 is not bundled;
  metadata-reuse withholding for Doria/BPL/Commonwealth is unchanged; LoC,
  Gallica/NLS, NDL and MDZ access gaps are unchanged.
