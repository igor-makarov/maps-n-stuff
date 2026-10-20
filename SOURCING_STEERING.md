# Sourcing steering — 20 October 2026

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
