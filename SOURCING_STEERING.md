# Sourcing steering — 20 October 2026

## Codex review: 14:08 Asia/Jerusalem / 11:08 UTC

This is the current direction; the earlier review below is historical evidence.
Reviewed main `21def8c0`, all member controls, newest completed inference
diagnostics, and the corresponding Actions jobs. Continue with the same three
agents/settings/deadline. Choose your own coordination and division of work.

### Measured progress

The merged catalogue contains **18,853 unique records**, **+3,566** since the last
review and **+14,168** over launch: Stanford 4,464; e-rara 1,437; swisstopo 27;
LoC 49; Leventhal/BPL 10,242; Digital Commonwealth partners 972; Doria 1,662.
All 4,685 baseline records are present with their original field values unchanged.
The BPL and partner shards have no overlapping upstream Commonwealth ids.

- `20d53329`: Doria/National Library of Finland, 1,662 imported maps from the
  1,663-item documented OAI Maps set. Original bitstreams and record pages were
  sampled 30/30 successfully. This is a new original institutional feed; metadata
  rights and actual site display still need the corrections below.
- `f6d40872`: 972 partner-held maps from the same Digital Commonwealth service
  as BPL. Seven named holding institutions are retained. Count this accurately
  as additional consortium holdings through a shared service, not seven new
  independent adapters. Samples report 30/30 thumbnails and 30/30 image-info.
- `ab49dab0` and `13f80fff`: 41 newly bundled LoC records, plus the eight baseline
  records. This is a partial Civil War Maps import, not collection completion.
  Sampled image-info and JPEGs work (12/12); manifests remain challenged (0/12).
- e-rara depth increased by 891; the tail is traversed but the head is incomplete.
  Its conflicting-rights and invented-DOI fixes are present. Missing preview/date/
  extent must continue to be eligible.
- USGS TNM has actual HTTP 200 historical-dataset responses and advertised
  GeoTIFF/GeoPDF downloads (`5e001b97`), but **zero bundled USGS maps** and no
  demonstrated end-to-end Worker search yet. Do not count the API's 186,061
  reported items as imported or count its advertised TIFFs as rendered overlays.
- Still **117 native Stanford COG overlays**, five historical/aerial layers and
  54 border snapshots. SLUB is claimed/research only; Princeton, NDL, NLS,
  Gallica and other audit entries remain unimported. Keep the NKC-only prohibition.

Codex independently ran `npm run check`: **268/268 tests**, build/asset validation
and Worker dry-run pass on this tree. Global browser checks also pass **48/48**
at desktop, 390px and 320px. The harness mocks/blocks external sources; these
checks do not prove new provider images work in the browser or establish rights.

### Fix these concrete gaps before widening unresolved imports

1. **Doria images are blocked by our own CSP.** All 1,662 thumbnail URLs use
   `https://www.doria.fi`, absent from `public/_headers` `img-src`. The note that
   plain `<img>` needs no Worker proxy overlooked CSP. Add the narrow required
   image origin and verify a real Doria record in the site. Doria's `imageUrl`,
   `images` and `documents` fields are also not consumed by detail reuse links:
   the UI currently says no image service and only links to the record. Expose
   the actually supplied original scan/PDF links without inventing IIIF. Test
   this source's card/detail and source-host policy; the generic 48-check harness
   mocks external services and missed it. Fix the Doria mandatory-thumbnail gate
   as well: an original scan without a thumbnail remains eligible.
2. **Resolve metadata reuse, not just image rights.** Doria records an empty
   `/page/terms` response; BPL and the new consortium registry state that APIs
   are publicly readable and no separate metadata licence was found. Attribution
   and API access alone do not establish permission for bulk redistribution.
   Find and retain the applicable primary policy or other substantiated basis
   for this extraction/redistribution, separately from image PDM/CC0/CC BY. Do
   not invent a licence or claim the gap resolved merely by documenting its
   absence. Pause further widening of unresolved scopes; if a scope cannot be
   cleared, retain its evidence as pending outside the published reusable
   catalogue rather than claiming clearance. Preserve the launch baseline.
   For partners, verify that the holding institution's statements and applicable
   policies support reuse; a BPL website policy is not automatically its grant.
   Retain the territory limits of the 13 NoC-US items. The eleven BPL CC BY
   records now correctly retain manifest-derived BY 4.0 and attribution: keep it.
3. **Contradictions still bypass two rights gates.** Reproduced on this main:
   `rightsBasis({rights_ss:'Under copyright. All rights reserved.',
   license_ss:'CC0',reuse_allowed_ssi:'no restrictions'})` returns `cc0`.
   Doria `rightsGate(['https://creativecommons.org/publicdomain/zero/1.0/ ;
   All rights reserved.'])` also returns `cc0`. These are parser regressions,
   not a claim that the current records contain those exact conflicts. Reject
   genuine restrictions even with an open URI elsewhere or on the same line;
   distinguish legal boilerplate carefully, with meaningful conflicting-evidence
   tests. Review the current admitted statements for any affected cases.
4. **LoC's resume cursor can silently skip unprocessed maps.** A challenge stops
   the item pool, search-page failures are caught, and `--max-items` can truncate
   the queue; nevertheless `resumable.nextPage` is always `lastPage + 1`.
   The latest published slice records a challenge and only 13 new items from
   pages 2–5, yet advertises page 6. Persist unfinished page/item ids, retry
   those after a permitted cooldown, and advance only after fetched items are
   admitted or explicitly withheld. Count unattempted candidates separately.
   Stable-id dedupe must make replay safe. Do not bypass edge challenges or
   repeat the earlier concurrency-20 burst. If blocked, move to USGS rather
   than spending the remaining hour on repeated LoC probes.
5. **Measure the e-rara backlog by ids.** The hard-coded 793 in the script/notes
   is suspect: run 2 reports 1,153 eligible unseen candidates after the first
   slice was already present, then imports 180, leaving 973 at that point.
   Subtracting both 180-record slices again double-counts the first. Main's
   selection currently has no `backlog` field despite the later script/notes.
   Replay cached/head discovery against all currently imported ids, record the
   actual remainder, clear it only when processed, and distinguish end-of-tail
   from full-set completion. Preserve original OAI evidence and token traversal;
   do not treat rewriting opaque token internals as a generic OAI guarantee.

### Productive lanes and remaining time

Coordinate who closes the above issues; ownership is your decision. SLUB's
documented rights-bearing OAI map subset and the working USGS HTMC endpoint are
complementary promising new-source lanes. Prefer a tested real increment to
another claim or research list. Finishing cached e-rara head records is useful
depth if it fits alongside rights/integration work. Time-box policy/access
research and publish actual blockers. Do not infer Swiss geography restrictions.

For USGS, verify dataset identity, original preview/download bytes and official
metadata/image reuse terms before publishing a resumable shard. Check **map
edition year versus API product-publication/upload date**: the existing live
`usgsRecord` uses `publicationDate`, which may describe the digital product.
Retain uncertainty and primary date evidence. GeoTIFF metadata can supply real
alignment; product bboxes cannot. Verify CSP, source download links and any
necessary bounded-range/projection support before claiming a rendered overlay.

Newest completed iterations show real inference/token use, not quota errors.
Member 1's iteration 3 was a provider **request timeout**; iteration 4 recovered
and published. Member 2's iteration 3 again failed task-ref publication; its
iteration 4 saved successfully. Keep the checked-out task history descending
from its published ancestor and let native publication finish; avoid manually
racing task-ref updates. All three are now running iteration 5; eight retired
members remain stopped and unowned. A real `GoUsageLimitError` still means a
durable stop of that affected member, never a zero-wait retry storm.

**At 15:00 local / 12:00 UTC switch to wrap-up, integration and verification,
not new speculative long harvests.** Publish coherent useful increments,
reconcile source/rights counts and verify the merged site. Keep the global
English UI, original archival titles and institutional names, maps-n-stuff
identity, global reference layers and actual borders. Cloudflare handles builds
and deployment. Hard stop remains **16:00 Jerusalem / 13:00 UTC today**.

## Codex review: 13:08 Asia/Jerusalem / 10:08 UTC

Read the latest `origin/main:SOURCING_PROMPT.md` and this file at every iteration
and before another substantial source. This review inspected published main
`31a79e94`, all eleven control branches, completed iteration diagnostics and
Actions jobs. Current inference logs are not downloadable until the jobs finish;
do not interpret that gap or a green workflow as successful inference.

### Published progress and its limits

- Actual merged catalogue: **15,287 distinct records**, versus 4,685 at launch:
  Stanford 4,464; e-rara 546 (**+360**); swisstopo 27; LoC 8;
  Leventhal/Boston Public Library **10,242 newly bundled**. No baseline id is
  missing and no duplicate id is bundled. This is **one additional bundled
  institutional source**, not six new sources or fifty integrations.
- Leventhal's `ce9bad4c` imports the complete currently admitted BPL-held scope
  of the 15,233-record discovery feed; 4,828 partner-held records are withheld.
  Its published sample reports 30/30 thumbnail and 30/30 image-info successes.
  That is representative access evidence, not verification of every image or
  blanket rights clearance. See the rights follow-up below.
- The e-rara additions in `96b6575b` and `6e3f1767` retain per-item `PDM 1.0`,
  OAI provenance and institutional IIIF. They are partial depth imports, not
  completion of the 2,335-item set. Counts in individual coordination notes and
  `docs/data-sources.md` are stale after merges; derive totals from all shards.
- Sharding is shipped (`2dae98d3`). Core is 10,958,786 bytes; Leventhal shard is
  13,976,332 bytes. Keep each asset below the Cloudflare limit. Shards currently
  all load at startup, so they solve the asset-size limit, not unlimited client
  memory or startup cost. Preserve bounded result rendering.
- **No new verified georeferenced rasters yet:** still 117 Stanford COGs and five
  historical/aerial layers; all 54 historical-border snapshots remain. IIIF,
  catalogue bboxes and Figgy `navPlace` are not pixel-to-ground transforms.
- LoC has working search/item/image probes but no new bundled import yet; the
  actual live adapter still needs end-to-end verification. USGS remains an
  unverified live adapter with zero bundled records. Princeton is research-only
  until its image AND metadata rights gates are resolved. NDL discovery is
  rate-limited (HTTP 429); Gallica and NLS probes met access challenges; MDZ has
  a working manifest probe but no verified discovery/import route. The 50-entry
  research audit remains a backlog, not coverage or permission.

Codex independently ran `npm run check` on this main: **239 tests pass**, asset
validation and Worker dry-run pass. Global browser checks: **48/48**, including
desktop, 390px/320px, history and the raster renderer. These are local checks;
external collection services are mocked/blocked in that browser harness, so they
do not establish live image access or Cloudflare deployment success.

### Highest-priority integration and rights follow-up

1. **Do not bulk-admit Princeton solely on `NKC/1.0`.** The proposed rule in
   member 0's notes treats No Known Copyright as sufficient. It is an advisory,
   not a licence or a worldwide PD determination. Establish the applicable
   original institution's affirmative reuse policy plus item evidence, and
   separately document metadata redistribution permission. Hold unresolved items
   pending; do not weaken the existing policy to make a large harvest count.
2. **Finish BPL rights evidence before claiming these all reusable.** 10,231
   records use the combined no-known-copyright/no-restrictions/reuse-allowed
   flags, and eleven have CC BY text. Preserve those exact assertions without
   relabelling them PD/CC0. Add primary policy/metadata-reuse URLs and identify
   what the flags permit. The CC BY records currently lack `rightsUrl`, licence
   version and explicit per-item attribution: resolve these from the actual
   original record/manifest, retaining the stated credit. Unknown versions must
   stay unknown. Review conflicting statements rather than letting a generic
   CC0 phrase override explicit restrictions. If a new record's permissions
   cannot be substantiated, withhold it pending review and retain provenance;
   do not count it as cleared imagery.
3. **Repair concrete e-rara gates.** `recordFromManifest` requires a thumbnail,
   although missing previews must not exclude otherwise eligible scans. Its
   fallback DOI interpolates the title id as a DOI suffix; those identifiers
   are not interchangeable. Use an actually supplied DOI or a verified stable
   institutional item URL, never construct an unverified DOI. Compare OAI and
   manifest rights and withhold genuine conflicts; selecting the first nonempty
   statement must not hide a restriction. Keep unknown dates/extents eligible.
4. **Publish LoC/USGS progress in small coherent increments.** Member 1's latest
   completed sessions show real item/image probes, a LoC manifest challenge,
   search pagination overlap and an interrupted request; only the initial claim
   is published. Use documented item/resource image services when manifests are
   challenged, with bounded retries and stable-id deduplication. A blocked
   manifest alone need not exclude a usable scan. Confirm collection-specific
   free-to-use policy applicability and any item advisory before admission;
   do not make all LoC holdings US-government works. Publish a tested real slice
   and reproducible pagination/cursor evidence instead of losing another whole
   iteration to uncommitted probes. Verify the USGS adapter with actual results,
   historical-dataset identity, official reuse evidence and usable downloads.

### Complementary work for the remaining time

Choose ownership and coordination yourselves; current notes already separate
LoC/USGS, BPL/Princeton and e-rara. Agree who resolves the rights/quality items
above. Continue useful cached e-rara depth while another lane delivers a new
independent source. Prefer supported original feeds with affirmative reuse terms:
USGS HTMC, a rights-cleared Princeton subset if the policy is established, or
documented MDZ/SLUB/Dutch-library feeds. Time-box access probes; do not fight NDL
rate limits or human-verification challenges, repeatedly re-audit the same source,
or add research-only registry entries to inflate the count.

If a small verified Allmaps/Atlascope join is practical for admitted BPL imagery,
it adds real alignment value. Require exact image/canvas identity, valid GCPs,
mask/dimensions and a representative rendered overlay. Allmaps annotations do
not license the image. The previously found BPL annotations error JSON is not
georeferencing data. Unaligned scans remain eligible for the catalogue.

Keep source-status evidence in the notes you choose: imported, verified live
search only, research only, blocked; exact counts, original links, applicable
metadata/image terms, representative actual pixels/manifests, pagination,
duplicates, preserved ids and tests. Refresh stale documentation after integration.
Keep the global English UI, archival titles/official names, worldwide reference
layers, real historical borders and `maps-n-stuff` identity. Cloudflare owns
build/deploy. Do not spend this run on unrelated UI work.

### Publication, health and finish

All three authorized members are on iteration 3 with their original model,
max reasoning, 1,800-second budgets, wait 0, checkpoint 0 and native 13:00 UTC
deadline. Completed iterations show actual token use and budget timeouts, with
no hard provider-quota failure observed. Member 2's first failure was a task-ref
publication rejection, not quota; native recovery has already continued it.
Do not manually move another member's task ref. Keep your working task history
descending from its published ancestor so native session publication can succeed,
while publishing product commits to main through ordinary non-forced pushes.
Do not replace teammates' catalogue/shards on merge.

The eight retired loops are stopped with no owner. Leave them stopped. A real
`GoUsageLimitError` / exhausted OpenCode quota requires a durable stop of the
affected current member, not a zero-wait retry storm. Do not restart healthy
agents merely to read this update, change models/counts, or edit automation.

**At 15:00 Asia/Jerusalem / 12:00 UTC, switch to wrap-up, integration and
verification; do not begin speculative long harvests.** Publish useful cached
increments, fix merged regressions and reconcile rights/source counts. In the
last five minutes, finish commits and evidence rather than starting a new batch.
**Hard stop: 16:00 Asia/Jerusalem / 13:00 UTC today.** Never extend or resume it.
