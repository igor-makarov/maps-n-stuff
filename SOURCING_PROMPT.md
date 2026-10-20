# Expand the global historical-map catalogue

The user's current objective is to solve sourcing and accumulate as many real,
usable map sources and historical maps as possible before today's deadline.
This brief supersedes older four-agent, German or Zurich-first instructions.

## Run and coordination

You are one of **three** Shurik agents using
`opencode-go/deepseek-v4.1-flash` with **max** reasoning. The iteration budget is
**1,800 seconds**, with **zero waiting** between iterations. The authoritative
deadline is in `.github/shurik/sourcing-run.json`: **20 October 2026, 16:00
Asia/Jerusalem (13:00 UTC)**. Do not extend it or resume after it.

Coordinate with the other two agents and figure out your own division of work,
communication method, source ownership and integration cadence. Avoid duplicate
harvests, conflicting adapters and repeated research. Use your supplied swarm
identity; a task branch is not a separate product.

At every iteration start, and before taking on another substantial source:

1. Fetch `origin/main` and inspect recent integrated work.
2. Read the latest `origin/main:SOURCING_PROMPT.md` and
   `origin/main:SOURCING_STEERING.md` with `git show`; the initial task-branch
   copy may be older. Codex will update steering based on actual progress.
3. Check the other agents' published work and current source ownership before
   choosing a source. Keep your current work and branch history intact.

**Commit and push validated product work directly to `main`.** The agents are
responsible for commits: automatic checkpoints/task commits remain disabled
(`checkpoint-seconds: 0`). Commit useful increments frequently, integrate without
force pushes, preserve teammates' changes, and keep task history descending from
the published task branch so Shurik can save sessions. Do not create PRs instead
of integrating. Cloudflare handles build and deployment from `main`.

## Starting point: build on it

The current English product is Meridian Atlas in repository `maps-n-stuff`.
The baseline is **4,685 maps**: 4,464 Stanford, 186 e-rara, 27 swisstopo and eight
Library of Congress records. There are **117 native Stanford georeferenced
rasters**, five regional historical/aerial layers and 54 historical-border
snapshots. Preserve these records, links, rights and working features.

Read `docs/global-integration.md`, `docs/global-catalogue-audit.md`,
`docs/automatic-georeferencing.md`, `data/catalogue-source-audit.json`, and the
actual importer/Worker adapters. The 50-entry audit is a research backlog, not a
cleared or integrated source list, and does not cover every advertised partner.

Existing LoC, Leventhal and USGS live adapters need real endpoint validation.
Fixtures and registry entries alone do not establish a working integration.
The earlier Codex workspace blocked collection hosts; the GitHub runner may
reach them. Test access rather than carrying that old limitation forward.

## What counts as progress

Prioritize **independently usable original collections with real imports**,
then increase depth and coverage of existing collections. Follow archive,
library, museum, university and survey-agency sources rather than scraping
OldMapsOnline or making it the application's backend.

- Use documented APIs, official exports, IIIF collections/manifests, OAI-PMH,
  WMS/WMTS, institutional geospatial catalogues and openly licensed repositories.
- Evaluate high-yield sources such as LoC, USGS HTMC, Leventhal/BPL, Gallica,
  NYPL, NLS, Harvard/Princeton geospatial collections, SLUB, Dutch institutions,
  Japanese libraries and other international holding collections. Choose and
  prioritize using evidence and the audit; this is not a fixed assignment.
- Inspect primary terms and representative records before bulk import. Metadata
  reuse and image reuse are separate questions. Record the actual permission,
  licence URL, institution, original record, identifiers, endpoints, attribution,
  retrieval date and a stable verification example.
- Public access, old age, an aggregator listing, a website footer or absence of
  a copyright warning is not sufficient image permission. Unknown/conflicting
  rights stay out of reusable imagery. Do not silently weaken rights gates or
  label unknown items public domain. Honour attribution/share-alike conditions.
- Add real rights-cleared data, reproducible harvesters and functioning previews
  or original-image access. Distinguish research-only, blocked, live-search-only
  and fully imported providers in reporting. Never inflate source counts by
  splitting one institutional feed into pretend institutions or importing empty
  placeholders, generated sample maps or HTTP error JSON as data.
- **Georeferencing is strongly preferred, not required.** Retain eligible scans
  without alignment, a known extent, publication date or thumbnail. Prefer native
  GeoTIFF/COG, documented georeferenced tiles and verified Allmaps annotations.
  A IIIF image, place pin or bounding box is not an image transformation. Preserve
  projection/control-point evidence; label unverified alignment honestly.
- Preserve original titles, dates, creators, languages and holding names. Keep
  publication/digitization dates separate from the period depicted. Do not invent
  missing metadata or translate historical titles into fake catalogue titles.

## Coverage, scale and verification

Expand worldwide coverage and institutional diversity. Do not impose a Swiss
window, arbitrary decade quotas or tiny showcase caps on a public reusable feed.
Paginate through eligible holdings; use caching, deduplication, resume support,
bounded concurrency and institution-friendly request rates. Preserve prior data
when refreshing a provider and make imports repeatable.

Keep the site usable as data grows. Cloudflare static assets have per-file size
limits; use appropriate shards/indexes and incremental loading if needed instead
of shipping an unbounded monolithic JSON or rendering thousands of rows at once.
Do not introduce paid services, account dependencies or secret credentials without
an existing authorized configuration. Never commit credentials or raw API tokens.

Verify original records, licence evidence, API pagination, actual manifest/image
availability and georeferenced services. Add meaningful adapter/rights regressions
and test the integrated UI. `npm run check` builds, runs unit tests and packages
the Worker. `scripts/browser-global-check.mjs` checks the global UI, native raster
renderer and phone layouts; fixtures do not substitute for live source tests.
Report verification gaps explicitly. Do not make every test pass by weakening it.

## Preserve the corrected product

Keep all product UI and generated labels **English**, retaining verbatim archival
titles and official names. Zurich is a typography/spacing/colour design reference,
not the site's geography or identity. Keep the original Meridian Atlas globe,
worldwide OSM/NASA layers, global place search, changing historical borders,
working filters, comparisons, genuine overlays and graceful error handling.
Do not rebrand, rebuild the existing app or add unrelated UI polish at the expense
of sourcing. The package and Worker remain `maps-n-stuff`.

Do not edit workflow launch/stop controls, add agents, change models, enable
checkpoints, restart retired loops or change the deadline. Hard provider quota
errors such as `GoUsageLimitError` require a durable stop and a recorded blocker,
not an endless retry loop. Ordinary temporary upstream failures should be handled
politely without fabricating a successful import.

## Finish

Use the final 15 minutes for integration and verification. In the final five
minutes, publish coherent commits and source-status evidence; do not start a new
large harvest. Leave actual counts, newly usable providers, examples, remaining
rights/access blockers and verification results in the coordination notes you
choose. Stop at the deadline; do not claim that a registry listing equals coverage.
